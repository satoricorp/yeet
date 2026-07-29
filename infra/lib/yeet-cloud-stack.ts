/**
 * yeet-cloud-stack.ts — everything `yeet sync` and `yeet cloud` need on AWS, in one stack.
 *
 * The design mirrors the local layout tier for tier:
 *
 *   local ~/.yeet/agents/<n>/         s3://<bucket>/agents/<n>/      the 13 KB of truth
 *   local 2.4 GB guest image          ECR image `yeet-runner`        the immutable tools
 *   local APFS clone scratch          the task's ephemeral disk      rebuilt, never synced
 *
 * Isolation note: locally yeet brings its own walls (libkrun). On Fargate the walls are
 * AWS's — every task runs inside Amazon's Firecracker microVM. Same file contract inside,
 * different owner of the hypervisor. That is the deliberate trade that makes this stack
 * ~zero ops: no fleet, no /dev/kvm, no AMIs.
 *
 * Cost posture: everything here is pay-per-use except literally nothing — no NAT gateway
 * (public subnets + assignPublicIp instead, saving $32/mo of standing cost), no load
 * balancer (agents are batch jobs, not services), logs expire, old state versions expire.
 * An idle deployment of this stack costs cents (S3 objects + ECR storage).
 */
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";

export class YeetCloudStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── state: the S3 half of `yeet sync` ────────────────────────────────────────────────
    // Versioned, because state pushes are the kind of thing you want an undo for — a bad
    // sync overwriting events.jsonl should be a version rollback, not a data loss. Old
    // versions expire so the undo window costs pennies rather than growing forever.
    const state = new s3.Bucket(this, "State", {
      bucketName: `yeet-state-${this.account}-${this.region}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(30) }],
      // State survives stack deletion on purpose: `cdk destroy` removing infra should never
      // be able to delete agents' work.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── runtime: the image the runner boots from ─────────────────────────────────────────
    const repo = new ecr.Repository(this, "Runner", {
      repositoryName: "yeet-runner",
      lifecycleRules: [{ maxImageCount: 10 }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      emptyOnDelete: false,
    });

    // ── network: public subnets, no NAT ──────────────────────────────────────────────────
    // A NAT gateway is $32/mo of standing cost to give private subnets internet. Agent
    // tasks need outbound only (ECR pull, model API, S3) and expose nothing inbound, so
    // public-with-assignPublicIp is strictly cheaper and no less safe: the security group
    // has no ingress rules at all.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC }],
    });
    const sg = new ec2.SecurityGroup(this, "TaskSg", {
      vpc,
      description: "yeet runner tasks: all egress, zero ingress",
      allowAllOutbound: true,
    });

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: "yeet",
      containerInsightsV2: ecs.ContainerInsights.DISABLED, // per-task metrics cost more than the tasks here
    });

    // ── the provider key ──────────────────────────────────────────────────────────────────
    // A placeholder the operator fills once:
    //   aws secretsmanager put-secret-value --secret-id yeet/openrouter --secret-string sk-...
    // Injected as an env var by ECS at task start; never in the image, never in the task
    // definition JSON, never in this repo.
    const providerKey = new secrets.Secret(this, "ProviderKey", {
      secretName: "yeet/openrouter",
      description: "OpenRouter API key for yeet cloud runners (fill with put-secret-value)",
    });

    // ── the task ─────────────────────────────────────────────────────────────────────────
    // ARM64, matching everything else yeet builds (pi, bun, and the local guest are all
    // arm64) — and Graviton Fargate is ~20% cheaper than x86 anyway.
    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: "/yeet/runner",
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const task = new ecs.FargateTaskDefinition(this, "RunnerTask", {
      family: "yeet-runner",
      cpu: 2048,
      memoryLimitMiB: 4096,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    task.addContainer("runner", {
      containerName: "runner",
      image: ecs.ContainerImage.fromEcrRepository(repo, "latest"),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "agent" }),
      secrets: { OPENROUTER_API_KEY: ecs.Secret.fromSecretsManager(providerKey) },
      environment: { YEET_S3_BUCKET: state.bucketName },
      // YEET_AGENT / YEET_TASK / YEET_MODEL arrive as per-run overrides from `yeet cloud`.
    });

    // Task role = what the AGENT'S RUNNER may do: its own state prefix and nothing else.
    // Deliberately not bucket-wide — a compromised runner should not be able to read other
    // agents' sessions. The prefix condition does the scoping the lease cannot.
    state.grantReadWrite(task.taskRole, "agents/*");
    // (Execution role — ECR pull + log writes — is granted automatically by the constructs.)

    // ── what the CLI reads ───────────────────────────────────────────────────────────────
    // `yeet cloud` discovers everything with one describe-stacks call and caches it. Output
    // keys are the contract; renaming one is a breaking change to src/cloud.ts.
    new cdk.CfnOutput(this, "StateBucket", { value: state.bucketName });
    new cdk.CfnOutput(this, "ClusterArn", { value: cluster.clusterArn });
    new cdk.CfnOutput(this, "TaskDefinitionArn", { value: task.taskDefinitionArn });
    new cdk.CfnOutput(this, "SubnetIds", {
      value: vpc.publicSubnets.map((s) => s.subnetId).join(","),
    });
    new cdk.CfnOutput(this, "SecurityGroupId", { value: sg.securityGroupId });
    new cdk.CfnOutput(this, "RunnerRepoUri", { value: repo.repositoryUri });
  }
}

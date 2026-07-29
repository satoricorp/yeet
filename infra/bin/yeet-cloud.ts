#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { YeetCloudStack } from "../lib/yeet-cloud-stack";

const app = new cdk.App();
// One stack, fixed name — src/cloud.ts discovers outputs by this exact name.
new YeetCloudStack(app, "YeetCloud", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

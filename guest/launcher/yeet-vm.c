/*
 * yeet-vm.c — boot a libkrun microVM for one yeet iteration.
 *
 *   yeet-vm --root PATH [OPTIONS] -- CMD [ARGS...]
 *
 * Derived from ~/git/firecracker/agent/agent.c (proven 2026-07-24), plus three things
 * that single-shot spike did not need:
 *
 *   1. Flags instead of hardcoded 2 vCPU / 2048 MiB, so the orchestrator sizes each VM.
 *   2. Extra virtio-fs mounts (--mount TAG=HOSTPATH). This is what lets run state live
 *      outside the cloned rootfs; the guest init reads YEET_MOUNTS to mount them.
 *   3. An EXPLICIT environment. krun_set_exec() with envp=NULL "auto-generates an array
 *      collecting the variables currently present in the environment" — i.e. it would
 *      hand the operator's entire shell, including secrets, to the guest. We never pass
 *      NULL, and we do not forward the host environment.
 *
 * Build with `make` (compiles + codesigns with the hypervisor entitlement, which is
 * required to call Hypervisor.framework).
 *
 * THE CALLER MUST SET DYLD_LIBRARY_PATH=$(brew --prefix)/lib. libkrun dlopen()s
 * libkrunfw.<N>.dylib by *leaf name* at runtime: it never appears in `otool -L`, and
 * -rpath cannot reach it because libkrunfw's install name is absolute. Without the env
 * var you get "Couldn't find or load libkrunfw.5.dylib" and exit 1 in ~36ms.
 *
 * Exit codes:
 *   64        launcher config error (usage, bad path, libkrun setup failure)
 *   125/126/127  reserved by libkrun's in-guest init: cannot set up the environment /
 *                found the executable but cannot execute it / cannot find it
 *   *         otherwise the workload's own exit code — once the microVM shuts down,
 *             libkrun exit()s the process with it.
 *
 * krun_start_enter() never returns on success; this process becomes the VM supervisor.
 */
#include <errno.h>
#include <getopt.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libkrun.h>

#define EXIT_CONFIG 64 /* outside libkrun's reserved 125-127 */

#define MAX_MOUNTS 8
#define MAX_ENV 64

/* Environment handed to the guest. Deliberately small and explicit: no host passthrough.
 * NO_COLOR/CI keep ANSI escapes out of logs (they inflate prompts and destabilise the
 * failure signatures the loop uses to detect no-progress) and stop test runners from
 * entering watch mode, which would otherwise hang until the timeout. TERM=dumb for the
 * same reason — the spike's xterm-256color invited colour. */
static const char *const base_env[] = {
    "HOME=/root",
    "TERM=dumb",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "LC_ALL=C.UTF-8",
    "NO_COLOR=1",
    "CI=1",
};

static const char *envp[MAX_ENV + 8];
static int envp_n;

static char mounts_env[PATH_MAX * 2];

__attribute__((format(printf, 1, 2), noreturn)) static void die(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "yeet-vm: ");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
    exit(EXIT_CONFIG);
}

/* Set "K=V", replacing any existing entry with the same key so --env always wins over
 * the defaults above. Pointers come from argv or string literals, both stable for the
 * life of the process. */
static void env_set(const char *kv)
{
    const char *eq = strchr(kv, '=');
    if (eq == NULL || eq == kv)
        die("--env expects K=V, got \"%s\"", kv);

    size_t keylen = (size_t)(eq - kv) + 1; /* compare through the '=' */
    for (int i = 0; i < envp_n; i++) {
        if (strncmp(envp[i], kv, keylen) == 0) {
            envp[i] = kv;
            return;
        }
    }
    if (envp_n >= MAX_ENV)
        die("too many --env entries (max %d)", MAX_ENV);
    envp[envp_n++] = kv;
}

static int check(int err, const char *what)
{
    if (err) {
        errno = -err;
        perror(what);
    }
    return err;
}

static void usage(void)
{
    fprintf(stderr,
            "usage: yeet-vm --root PATH [OPTIONS] -- CMD [ARGS...]\n"
            "\n"
            "  --root PATH           host dir shared as guest /            [required]\n"
            "  --cpus N              vCPUs                                [default 2]\n"
            "  --mem MIB             guest RAM in MiB                     [default 2048]\n"
            "  --mount TAG=HOSTPATH  extra virtio-fs device, repeatable   [max 8]\n"
            "  --workdir PATH        guest cwd                            [default /]\n"
            "  --env K=V             guest env var, repeatable            [max 64]\n"
            "  --console PATH        write guest console output to PATH\n"
            "  --log-level N         libkrun log level 0..5               [default 2]\n");
    exit(EXIT_CONFIG);
}

int main(int argc, char *const argv_in[])
{
    const char *root = NULL;
    const char *workdir = "/";
    const char *console = NULL;
    unsigned cpus = 2;
    unsigned mem = 2048;
    unsigned log_level = KRUN_LOG_LEVEL_WARN;

    const char *tags[MAX_MOUNTS];
    const char *paths[MAX_MOUNTS];
    int n_mounts = 0;

    for (size_t i = 0; i < sizeof base_env / sizeof *base_env; i++)
        envp[envp_n++] = base_env[i];

    enum { OPT_ROOT = 1000, OPT_CPUS, OPT_MEM, OPT_MOUNT, OPT_WORKDIR, OPT_ENV, OPT_CONSOLE, OPT_LOG };
    static const struct option opts[] = {
        {"root", required_argument, NULL, OPT_ROOT},
        {"cpus", required_argument, NULL, OPT_CPUS},
        {"mem", required_argument, NULL, OPT_MEM},
        {"mount", required_argument, NULL, OPT_MOUNT},
        {"workdir", required_argument, NULL, OPT_WORKDIR},
        {"env", required_argument, NULL, OPT_ENV},
        {"console", required_argument, NULL, OPT_CONSOLE},
        {"log-level", required_argument, NULL, OPT_LOG},
        {NULL, 0, NULL, 0},
    };

    int c;
    while ((c = getopt_long(argc, argv_in, "+", opts, NULL)) != -1) {
        switch (c) {
        case OPT_ROOT:
            root = optarg;
            break;
        case OPT_CPUS:
            cpus = (unsigned)strtoul(optarg, NULL, 10);
            break;
        case OPT_MEM:
            mem = (unsigned)strtoul(optarg, NULL, 10);
            break;
        case OPT_WORKDIR:
            workdir = optarg;
            break;
        case OPT_CONSOLE:
            console = optarg;
            break;
        case OPT_LOG:
            log_level = (unsigned)strtoul(optarg, NULL, 10);
            break;
        case OPT_ENV:
            env_set(optarg);
            break;
        case OPT_MOUNT: {
            if (n_mounts >= MAX_MOUNTS)
                die("too many --mount entries (max %d)", MAX_MOUNTS);
            char *eq = strchr(optarg, '=');
            if (eq == NULL || eq == optarg)
                die("--mount expects TAG=HOSTPATH, got \"%s\"", optarg);
            *eq = '\0'; /* argv is writable; splits in place */
            const char *tag = optarg;
            char *resolved = realpath(eq + 1, NULL);
            if (resolved == NULL)
                die("--mount path does not exist: %s", eq + 1);
            for (int i = 0; i < n_mounts; i++)
                if (strcmp(tags[i], tag) == 0)
                    die("duplicate --mount tag: %s", tag);
            tags[n_mounts] = tag;
            paths[n_mounts] = resolved;
            n_mounts++;
            break;
        }
        default:
            usage();
        }
    }

    if (root == NULL || optind >= argc)
        usage();

    char *const *cmd = &argv_in[optind];

    /* libkrun's argv transport corrupts any element containing BOTH '"' and '$': it
     * re-splits the element at its internal spaces and doubles a trailing quote. Measured
     * 2026-07-25 — the single argument
     *     echo "$b ok"
     * arrives in the guest as three arguments: [echo "$b] [ok""] [...]. Either character
     * alone is safe (long space-filled args survive; so do bare '$' and bare '"'), and
     * krun_set_env is entirely unaffected — env values round-trip byte-exact, JSON included.
     *
     * Refuse rather than corrupt silently: a mangled prompt or test command would surface
     * later as an inexplicable guest-side syntax error. Free text belongs in a file (which
     * is what the host<->guest contract does anyway, since the guest has no jq); short
     * structured values belong in --env. */
    for (int i = 0; cmd[i] != NULL; i++)
        if (strchr(cmd[i], '"') != NULL && strchr(cmd[i], '$') != NULL)
            die("argv[%d] contains both '\"' and '$', which libkrun's argv transport "
                "corrupts. Put it in a file or an --env value instead.\n  offending arg: %s",
                i, cmd[i]);

    /* Tell the guest what to mount. The guest init parses this rather than being handed
     * the same list twice on its command line. */
    if (n_mounts > 0) {
        size_t used = (size_t)snprintf(mounts_env, sizeof mounts_env, "YEET_MOUNTS=");
        for (int i = 0; i < n_mounts; i++) {
            int written = snprintf(mounts_env + used, sizeof mounts_env - used, "%s%s=%s",
                                   i ? "," : "", tags[i], paths[i]);
            if (written < 0 || (size_t)written >= sizeof mounts_env - used)
                die("--mount list too long for YEET_MOUNTS%s", "");
            used += (size_t)written;
        }
        env_set(mounts_env);
    }
    envp[envp_n] = NULL;

    krun_set_log_level(log_level);

    int ctx = krun_create_ctx();
    if (ctx < 0) {
        errno = -ctx;
        perror("krun_create_ctx");
        return EXIT_CONFIG;
    }

    if (check(krun_set_vm_config(ctx, cpus, mem), "krun_set_vm_config"))
        return EXIT_CONFIG;
    if (check(krun_set_root(ctx, root), "krun_set_root"))
        return EXIT_CONFIG;

    for (int i = 0; i < n_mounts; i++)
        if (check(krun_add_virtiofs(ctx, tags[i], paths[i]), "krun_add_virtiofs"))
            return EXIT_CONFIG;

    /* Outbound networking is transparent (TSI HIJACK_INET): libkrun enables it by default
     * when no other NIC is configured, so the guest's TCP connect()s are proxied through
     * the host — no tap device, no root. The agent reaches the model API and git remotes
     * with no extra setup. NOTE: this is unrestricted egress; see the egress-policy seam. */

    if (console != NULL && check(krun_set_console_output(ctx, console), "krun_set_console_output"))
        return EXIT_CONFIG;

    if (check(krun_set_workdir(ctx, workdir), "krun_set_workdir"))
        return EXIT_CONFIG;
    if (check(krun_set_exec(ctx, cmd[0], (const char *const *)&cmd[1], envp), "krun_set_exec"))
        return EXIT_CONFIG;

    check(krun_start_enter(ctx), "krun_start_enter");
    return EXIT_CONFIG; /* only reached if the VM failed to start */
}

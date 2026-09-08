# Langflow on AWS — Nudge Labs

AWS CDK (TypeScript) infrastructure that runs this Langflow fork on ECS Fargate,
behind a load balancer that only lets `@nudge-labs.com` Google accounts through.

| | |
| --- | --- |
| AWS account | `447237717633` (profile `nudge`) |
| Region | `eu-central-1` |
| URL | `https://langflow.nudge-platforms.com` |
| Hosted zone | `nudge-platforms.com` (`Z06341873QY47D6LWX87L`) |
| Who may sign in | any `@nudge-labs.com` Google account |

The hosting domain and the identity domain are deliberately different: Langflow is
served from `nudge-platforms.com` because that is the zone this account owns, while
sign-in is restricted to the `nudge-labs.com` Workspace. Nothing links the two.

```
                        Google Workspace
                               │  OIDC
                               ▼
  browser ──▶ Route53 ──▶ ALB :443 ──▶ Cognito user pool ──┐
                            │                              │  pre-sign-up Lambda
                            │  ◀───────────────────────────┘  rejects non-nudge-labs.com
                            │
                            │  forwards with x-amzn-oidc-data (ALB-signed JWT)
                            ▼
                    ECS Fargate (private subnets)
                            │
        ┌───────────────────┼────────────────────┬──────────────────┐
        ▼                   ▼                    ▼                  ▼
  Aurora Postgres      S3 (files)          EFS (config dir,     ElastiCache
  Serverless v2                            knowledge bases)     Redis
```

Nothing that fails the Google handshake reaches the container. The tasks' security
group accepts traffic only from the load balancer, so the `x-amzn-oidc-*` headers
cannot be forged by a direct request — and the ALB overwrites them on every request
regardless.

## Stacks

| Stack | Contents |
| --- | --- |
| `Langflow-<env>-Network` | VPC, three subnet tiers, NAT, VPC endpoints, every security group |
| `Langflow-<env>-Data` | KMS key, Aurora Serverless v2, S3, EFS, Redis, Langflow secret key, alarm topic |
| `Langflow-<env>-Auth` | Cognito user pool, Google identity provider, domain-restriction Lambda |
| `Langflow-<env>-Service` | Docker image, Fargate service, ALB + Cognito auth, ACM, Route53, WAF, alarms |

Security groups all live in the network stack. A group defined next to the resource
it protects and referenced from another stack makes the two stacks depend on each
other; keeping them in the one stack both others already depend on avoids that.
For the same reason the service stack receives data-tier resources as ARNs and
re-imports them, so its IAM grants never get written into another stack's resource
policy.

## What makes it persistent

Fargate task storage is thrown away when a task is replaced, so every piece of
Langflow state is externalised:

- **Aurora PostgreSQL** — flows, users, projects, message history, API keys.
  Serverless v2 scales down to 0.5 ACU when idle. Backups retained 14 days,
  deletion protection on, encrypted with the stack's CMK.
- **S3** — everything the file storage service writes (`LANGFLOW_STORAGE_TYPE=s3`).
  Versioned, KMS-encrypted, no public access.
- **EFS** — `LANGFLOW_CONFIG_DIR`. Langflow keeps on-disk knowledge bases and
  caches here, which is why an object store alone is not enough. Mounted with
  TLS and IAM authorisation through an access point pinned to uid 1000 / gid 0,
  matching the container's user.
- **Secrets Manager** — `LANGFLOW_SECRET_KEY`, which encrypts stored global
  variables. Generated once and marked `RETAIN`: if it changes, every stored
  credential becomes undecryptable.

## Prerequisites

Already true on the current workstation:

- Profile `nudge` reaches account `447237717633` with `AdministratorAccess`
- CDK is bootstrapped (v15) in `eu-central-1`
- Docker Desktop is running on `aarch64`, so the ARM64 image builds natively
- `nudge-platforms.com` is a public hosted zone in the account

Still needed once: a Google OAuth **web** client (below).

Docker Desktop's CLI symlink is not on `PATH` on this machine. Either enable it in
Docker Desktop → *Settings* → *Advanced*, or prefix the deploy:

```bash
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
```

## One-time setup

### 1. Create the Google OAuth client

Google Cloud Console → *APIs & Services* → *Credentials* → *Create credentials* →
*OAuth client ID* → **Web application**.

- Name: `Langflow (AWS Cognito)`
- **Authorised redirect URI** — exactly this, nothing else:

  ```
  https://nudge-labs-langflow.auth.eu-central-1.amazoncognito.com/oauth2/idpresponse
  ```

- Authorised JavaScript origins: leave empty. Cognito exchanges the code
  server-side, so the browser never calls Google directly.

On the OAuth consent screen, set *User type* to **Internal** so only
`nudge-labs.com` Workspace users ever see the consent prompt. That is a
convenience gate, not the control — the Cognito Lambda is what enforces the
domain, on both sign-up and every later sign-in.

The redirect URI is fixed before anything is deployed because it is derived from
`cognitoDomainPrefix` and the region in `lib/config.ts`. If the deploy ever fails
with a domain-already-exists error, that prefix was taken by another AWS account;
change it in config **and** update the redirect URI in Google to match.

### 2. Store the client secret

```bash
aws secretsmanager create-secret \
  --profile nudge --region eu-central-1 \
  --name langflow/prod/google-oauth-client-secret \
  --description "Google OAuth client secret for Langflow SSO" \
  --secret-string 'GOCSPX-...'
```

The client **id** is not a secret; it is read from `LANGFLOW_GOOGLE_CLIENT_ID`.

### 3. Deploy

```bash
cd infra
npm ci

export AWS_PROFILE=nudge
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
export LANGFLOW_GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com
export LANGFLOW_ALARM_EMAIL=platform@nudge-labs.com   # optional

npx cdk deploy --all -c env=prod
```

Or from the repository root: `AWS_PROFILE=nudge make infra_deploy env=prod`.

Account, region and hosted zone are baked into `lib/config.ts`, so no other
environment variables are required.

The first deploy builds the Langflow image from `docker/build_and_push.Dockerfile`
(target `full`) and pushes it to the CDK asset repository. Expect 15–30 minutes
end to end, most of it the image build and the Aurora cluster.

ACM validates the certificate by writing a record into `nudge-platforms.com`
automatically. If the deploy appears stuck on `Certificate` for more than ten
minutes, the zone lookup resolved to the wrong zone — check the cached value in
`cdk.context.json`.

### 4. Sign in

Open `https://langflow.nudge-platforms.com`. You are sent to Google, and on return
Langflow creates your user on first sign-in. The first person to sign in is **not**
a superuser; promote them once:

```bash
aws ecs execute-command --cluster langflow-prod --task <task-id> \
  --container langflow --interactive --command "/bin/sh"
# then, inside the task:
python -c "
import asyncio
from sqlmodel import select
from langflow.services.deps import session_scope
from langflow.services.database.models.user.model import User

async def main():
    async with session_scope() as db:
        user = (await db.exec(select(User).where(User.username == 'you@nudge-labs.com'))).first()
        user.is_superuser = True
        db.add(user)
        await db.commit()

asyncio.run(main())
"
```

## Continuous deployment

`.github/workflows/nudge-deploy-langflow.yml` deploys on every push to
`feature/prod-nl-iac`, in three jobs:

1. **validate** — `tsc --noEmit` and the unit tests. No AWS access.
2. **diff** — assumes `langflow-prod-github-diff` and runs `cdk diff --all`,
   posting the result to the run summary. Read-only.
3. **deploy** — runs in the `production` GitHub Environment, so it waits for a
   required reviewer, then assumes `langflow-prod-github-deploy`, deploys the
   four application stacks, waits for the ECS service to stabilise, and smoke
   tests that an unauthenticated request is still bounced to Google.

There are no AWS access keys anywhere. Both jobs mint short-lived credentials
through GitHub's OIDC provider.

**Why two roles.** The deploy role's trust policy matches only
`repo:NudgeLabsDOO/langflow:environment:production`. A job that does not declare
that environment — and therefore never hit the reviewer — receives a token whose
`sub` is the branch ref instead, and STS refuses it. The approval gate is
enforced by IAM, not merely by the GitHub UI. The diff role is trusted for the
branch ref but can only read CloudFormation.

Neither role carries permissions of its own beyond `sts:AssumeRole` on the CDK
bootstrap roles, so widening what the pipeline may do means changing the
bootstrap stack rather than quietly editing a policy here.

**The pipeline cannot deploy its own roles.** `Langflow-prod-Cicd` is left out of
the stack list on purpose — a pipeline that can rewrite its own trust policy can
also lock itself out of the account. Deploy it from a workstation:

```bash
AWS_PROFILE=nudge npx cdk deploy Langflow-prod-Cicd -c env=prod
```

**Runner architecture.** The deploy job runs on `ubuntu-24.04-arm`. The task
definition is ARM64, and emulating that build on an x86 runner turns roughly 25
minutes into hours. GitHub-hosted ARM runners are free for this public
repository.

**Changing the branch or environment name** means editing `githubBranch` /
`githubEnvironment` in `lib/config.ts`, redeploying `Langflow-prod-Cicd`, and
updating the trigger in the workflow — the values are baked into the IAM trust
policies.

## Configuration

Everything environment-specific lives in `lib/config.ts`. The `prod` and `dev`
entries differ mainly in sizing, WAF, and whether resources are retained on
delete. Select one with `-c env=<name>`.

The settings worth knowing about:

| Setting | Default (prod) | Notes |
| --- | --- | --- |
| `allowedEmailDomains` | `["nudge-labs.com"]` | The Workspace domain, not the hosting domain. Enforced by the Cognito Lambda on both sign-up and every sign-in; an empty list fails synth. |
| `allowApiKeyBypass` | `false` | See *Machine access* below. |
| `albIngressCidrs` | `["0.0.0.0/0"]` | Narrow to office/VPN ranges for defence in depth; SSO still applies either way. |
| `cpuArchitecture` | `ARM64` | Graviton, ~20% cheaper, and builds natively on Apple Silicon. Switch to `X86_64` if a bundle dependency has no aarch64 wheel or you build on x86 CI. |
| `imageSource` | `build` | Set to `registry` with `registryImage` to deploy a prebuilt tag instead of building locally. |
| `desiredCount` | `2` | Requires `useRedisCache`; synth refuses otherwise, because the in-memory cache is per task. |
| `removalPolicy` | `RETAIN` | Database, buckets and file system survive `cdk destroy`. |

## Operations

```bash
# Logs
aws logs tail /langflow/prod/service --follow

# Shell into a running task
aws ecs execute-command --cluster langflow-prod --container langflow \
  --interactive --command "/bin/sh" --task <task-id>

# Ship a new build of this checkout
make infra_deploy_service env=prod

# Restart without changing the image
aws ecs update-service --cluster langflow-prod --service langflow-prod \
  --force-new-deployment

# What would change?
make infra_diff env=prod
```

**Rotating the database password.** Automatic rotation is deliberately not
configured: ECS resolves secrets once, at task start, so a rotated password
leaves running tasks holding a credential the cluster no longer accepts. Rotate
manually, then immediately force a new deployment:

```bash
NEW=$(aws secretsmanager get-random-password --password-length 40 \
  --exclude-punctuation --query RandomPassword --output text)

aws rds modify-db-cluster --db-cluster-identifier langflow-prod \
  --master-user-password "$NEW" --apply-immediately

aws secretsmanager get-secret-value --secret-id langflow/prod/database \
  --query SecretString --output text \
  | jq --arg p "$NEW" '.password = $p' \
  | aws secretsmanager put-secret-value --secret-id langflow/prod/database \
      --secret-string file:///dev/stdin

aws ecs update-service --cluster langflow-prod --service langflow-prod \
  --force-new-deployment
```

`--exclude-punctuation` matters: the startup script interpolates the password
into a connection URL without percent-encoding it.

**Revoking a person's access.** Remove them from Google Workspace, or delete the
user from the Cognito pool. The pre-authentication trigger re-checks the email
domain on every sign-in, so removing a domain from `allowedEmailDomains` locks out
users created while it was allowed. Their Langflow rows stay in the database; delete
the Langflow user separately if you want their flows gone.

## Security notes and deliberate trade-offs

**Trusted header decode.** Langflow runs with
`LANGFLOW_EXTERNAL_AUTH_TRUSTED_JWT_DECODE=true` and reads `x-amzn-oidc-data`. The
signature is not verified, because the ALB publishes its signing keys as bare PEM
files rather than a JWKS document, which is what the JWKS path expects. The
boundary that makes this safe is the network: the tasks' security group accepts
traffic only from the load balancer's security group, and the ALB overwrites the
`x-amzn-oidc-*` headers on every request. If you ever put another ingress in front
of the tasks, this assumption breaks.

**Machine access.** With `allowApiKeyBypass: false` (the prod default), *everything*
goes through the Google handshake — including webhooks, MCP clients and CI jobs,
which cannot complete a browser redirect. Turning it on adds a listener rule that
forwards `/api/*` requests carrying an `x-api-key` header straight to Langflow,
which then validates the key itself. That widens the reachable surface to anyone
who can reach the load balancer, so it is off for prod and on for dev.

**Logout.** Langflow's logout clears Langflow's own cookies but not the ALB session
cookie, so the next page load re-authenticates silently. To sign out completely, send
the user to the Cognito logout endpoint:

```
https://nudge-labs-langflow.auth.eu-central-1.amazoncognito.com/logout?client_id=<clientId>&logout_uri=https://langflow.nudge-platforms.com/
```

**WAF.** The common rule set runs with `SizeRestrictions_BODY` and
`CrossSiteScripting_BODY` set to *count* rather than *block*: flow definitions and
file uploads are large JSON bodies that legitimately trip both.

**Synth-time guardrails.** `lib/security-checks.ts` is an aspect that fails `cdk
synth` if a security group opens anything but 80/443 to the internet, a bucket is
not fully public-access-blocked, the database is unencrypted, or the internet-facing
load balancer has no access logging. Loosening any of those is then a deliberate
edit to that file rather than an accident.

## Cost

Rough monthly steady state for `prod` in `eu-central-1`, idle-to-light usage:

| Item | Approx. USD/month |
| --- | --- |
| 2 × Fargate task (2 vCPU / 8 GB, ARM64) | ~135 |
| Aurora Serverless v2, 0.5–8 ACU (mostly idle) | ~45 |
| ElastiCache `cache.t4g.small`, primary + replica | ~50 |
| ALB | ~20 |
| NAT gateway (1) | ~35 |
| EFS, S3, KMS, logs, WAF | ~30 |
| **Total** | **~315** |

The `dev` environment (1 task, no Redis, no WAF, 0-ACU minimum) lands around 90.

To cut prod further: drop to one task with `useRedisCache: false` (−~110), or set
`auroraMinAcu: 0` to let the cluster pause when idle. Turning
`enableVpcEndpoints` on adds roughly 110/month for five interface endpoints
across three AZs.

## Teardown

```bash
make infra_destroy env=prod
```

With `removalPolicy: RETAIN` the Aurora cluster, S3 buckets, EFS file system, KMS
key and the Langflow secret key survive and must be deleted by hand once you are
certain. `dev` uses `DESTROY` and removes everything.

## Development

```bash
npm test          # unit tests over the synthesised templates
npx tsc --noEmit  # type check
make infra_synth env=dev
```

The tests stub the Route53 lookup through app context, so they run without AWS
credentials. `cdk synth` itself needs credentials because the VPC resolves its
availability zones by lookup.

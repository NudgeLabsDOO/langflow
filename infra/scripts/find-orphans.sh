#!/usr/bin/env bash
# List resources left behind when a Langflow stack rolls back.
#
# Everything in the data tier carries removalPolicy: RETAIN so a `cdk destroy`
# cannot take the database with it. The same policy applies to a *failed first
# create*: CloudFormation reports DELETE_SKIPPED and the half-built resource
# survives with no stack owning it. Deterministic names then make the next
# attempt fail early with an unhelpful ResourceExistenceCheck error.
#
# This prints those orphans and the command to remove each one. It deletes
# nothing — read the list, then run what you agree with.
#
#   ./scripts/find-orphans.sh [env]      # default: prod
set -euo pipefail

ENV_NAME="${1:-prod}"
: "${AWS_REGION:=eu-central-1}"
export AWS_REGION
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
STACK="Langflow-${ENV_NAME}-Data"

# An orphan is only an orphan if no live stack owns it. Two states do not count
# as ownership: REVIEW_IN_PROGRESS is an empty shell left by a change set that
# failed validation, and ROLLBACK_COMPLETE is a failed create that can never be
# updated. Both hold zero usable resources and both block the next deploy.
STATUS="$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo ABSENT)"

found=0
report() { found=1; printf '  %-58s %s\n' "$1" "$2"; }

case "$STATUS" in
  ABSENT)
    echo "$STACK does not exist. Checking for resources it would have owned."
    ;;
  REVIEW_IN_PROGRESS | ROLLBACK_COMPLETE)
    echo "$STACK is $STATUS — an empty shell, not a live stack."
    ;;
  *)
    echo "$STACK is $STATUS — these resources belong to it. Nothing to clean up."
    exit 0
    ;;
esac
echo

if [ "$STATUS" != "ABSENT" ]; then
  report "stack $STACK ($STATUS)" "aws cloudformation delete-stack --stack-name $STACK"
fi

for bucket in "langflow-${ENV_NAME}-files-${ACCOUNT}" "langflow-${ENV_NAME}-s3-access-logs-${ACCOUNT}"; do
  if aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    report "s3://$bucket" "aws s3 rb s3://$bucket --force"
  fi
done

for secret in "langflow/${ENV_NAME}/secret-key" "langflow/${ENV_NAME}/database" "langflow/${ENV_NAME}/redis-auth-token"; do
  if aws secretsmanager describe-secret --secret-id "$secret" >/dev/null 2>&1; then
    report "secret $secret" "aws secretsmanager delete-secret --secret-id $secret --force-delete-without-recovery"
  fi
done

fs_id="$(aws efs describe-file-systems \
  --query "FileSystems[?Name=='langflow-${ENV_NAME}'].FileSystemId | [0]" --output text)"
if [ "$fs_id" != "None" ] && [ -n "$fs_id" ]; then
  report "efs $fs_id" "aws efs delete-file-system --file-system-id $fs_id"
fi

key_id="$(aws kms list-aliases \
  --query "Aliases[?AliasName=='alias/langflow-${ENV_NAME}'].TargetKeyId | [0]" --output text)"
if [ "$key_id" != "None" ] && [ -n "$key_id" ]; then
  report "kms $key_id" "aws kms schedule-key-deletion --key-id $key_id --pending-window-in-days 7"
fi

cluster="$(aws rds describe-db-clusters \
  --query "DBClusters[?DBClusterIdentifier=='langflow-${ENV_NAME}'].DBClusterIdentifier | [0]" \
  --output text 2>/dev/null || echo None)"
if [ "$cluster" != "None" ] && [ -n "$cluster" ]; then
  report "rds cluster $cluster" "# holds data — delete by hand, deliberately"
fi

redis="$(aws elasticache describe-replication-groups \
  --query "ReplicationGroups[?ReplicationGroupId=='langflow-${ENV_NAME}'].ReplicationGroupId | [0]" \
  --output text 2>/dev/null || echo None)"
if [ "$redis" != "None" ] && [ -n "$redis" ]; then
  report "elasticache $redis" "aws elasticache delete-replication-group --replication-group-id $redis"
fi

if [ "$found" -eq 0 ]; then
  echo "  none — the next deploy has a clean slate."
fi

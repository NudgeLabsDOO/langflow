#!/usr/bin/env bash
# List resources left behind when a Langflow stack rolls back.
#
# The data tier carries removalPolicy: RETAIN so a destroy cannot take the
# database with it. The same policy applies to a failed *create*: CloudFormation
# reports DELETE_SKIPPED and the half-built resource survives with no stack
# owning it. Names are deterministic, so the next attempt then fails early with
# a bare [AWS::EarlyValidation::ResourceExistenceCheck] naming no resource.
#
# This prints those orphans and the command to remove each. It deletes nothing.
#
#   ./scripts/find-orphans.sh [env]      # default: prod
set -euo pipefail

ENV_NAME="${1:-prod}"
: "${AWS_REGION:=eu-central-1}"
export AWS_REGION
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"

found=0
report() { found=1; printf '  %-58s %s\n' "$1" "$2"; }

stack_status() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo ABSENT
}

# A stack in one of these states owns nothing usable, yet still blocks the next
# deploy: REVIEW_IN_PROGRESS is an empty shell from a change set that failed
# validation, and the ROLLBACK/DELETE failures are creates that never completed.
is_shell() {
  case "$1" in
    ABSENT | DELETE_COMPLETE | REVIEW_IN_PROGRESS | ROLLBACK_COMPLETE | ROLLBACK_FAILED | DELETE_FAILED)
      return 0 ;;
    *)
      return 1 ;;
  esac
}

# ---------------------------------------------------------------- data stack
DATA_STACK="Langflow-${ENV_NAME}-Data"
DATA_STATUS="$(stack_status "$DATA_STACK")"

if is_shell "$DATA_STATUS"; then
  echo "$DATA_STACK is $DATA_STATUS — checking what it left behind."
  if [ "$DATA_STATUS" != "ABSENT" ] && [ "$DATA_STATUS" != "DELETE_COMPLETE" ]; then
    report "stack $DATA_STACK ($DATA_STATUS)" "aws cloudformation delete-stack --stack-name $DATA_STACK"
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
else
  echo "$DATA_STACK is $DATA_STATUS — live, and its resources are not listed."
fi

# ------------------------------------------------------------- service stack
# Nothing here is retained any more, but a stack created before that change can
# still strand its access-log bucket, which blocks the next create just as hard.
SERVICE_STACK="Langflow-${ENV_NAME}-Service"
SERVICE_STATUS="$(stack_status "$SERVICE_STACK")"

if is_shell "$SERVICE_STATUS"; then
  echo "$SERVICE_STACK is $SERVICE_STATUS — checking what it left behind."
  if [ "$SERVICE_STATUS" != "ABSENT" ] && [ "$SERVICE_STATUS" != "DELETE_COMPLETE" ]; then
    report "stack $SERVICE_STACK ($SERVICE_STATUS)" "aws cloudformation delete-stack --stack-name $SERVICE_STACK"
  fi
  alb_logs="langflow-${ENV_NAME}-alb-logs-${ACCOUNT}"
  if aws s3api head-bucket --bucket "$alb_logs" >/dev/null 2>&1; then
    report "s3://$alb_logs" "aws s3 rb s3://$alb_logs --force"
  fi

  log_group="/langflow/${ENV_NAME}/service"
  if [ -n "$(aws logs describe-log-groups --log-group-name-prefix "$log_group" \
      --query "logGroups[?logGroupName=='$log_group'].logGroupName | [0]" --output text 2>/dev/null \
      | grep -v '^None$')" ]; then
    report "log group $log_group" "aws logs delete-log-group --log-group-name $log_group"
  fi

  if [ -n "$(aws cloudwatch list-dashboards \
      --query "DashboardEntries[?DashboardName=='langflow-${ENV_NAME}'].DashboardName | [0]" \
      --output text 2>/dev/null | grep -v '^None$')" ]; then
    report "dashboard langflow-${ENV_NAME}" "aws cloudwatch delete-dashboards --dashboard-names langflow-${ENV_NAME}"
  fi
else
  echo "$SERVICE_STACK is $SERVICE_STATUS — live, and its resources are not listed."
fi

echo
if [ "$found" -eq 0 ]; then
  echo "  none — the next deploy has a clean slate."
fi

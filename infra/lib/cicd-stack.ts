import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import type { LangflowEnvironment } from "./config";

export interface CicdStackProps extends StackProps {
  readonly config: LangflowEnvironment;
}

/** Qualifier of the CDK bootstrap stack in this account (the CDK default). */
const BOOTSTRAP_QUALIFIER = "hnb659fds";
const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";

/**
 * The two roles GitHub Actions assumes. No access keys exist anywhere.
 *
 * They are split so the approval gate means something. The diff role is trusted
 * for pushes to the deployment branch and can only read; the deploy role is
 * trusted *only* for the `production` GitHub Environment, and a job that has not
 * passed the environment's required reviewer gets a token whose `sub` does not
 * match it. Skipping the reviewer therefore fails at STS, not just in the UI.
 *
 * This stack is deployed from a workstation and is deliberately left out of the
 * set the pipeline deploys: a pipeline that can rewrite its own trust policy can
 * also lock itself out of the account.
 */
export class CicdStack extends Stack {
  public readonly deployRole: iam.Role;
  public readonly diffRole: iam.Role;

  constructor(scope: Construct, id: string, props: CicdStackProps) {
    super(scope, id, props);
    const { config } = props;

    // The account already has a GitHub OIDC provider; a second one for the same
    // issuer is rejected, so import rather than create.
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GithubOidcProvider",
      `arn:aws:iam::${this.account}:oidc-provider/${GITHUB_OIDC_HOST}`,
    );

    /**
     * Both spellings of the OIDC subject for one job context.
     *
     * GitHub is rolling out immutable subject claims, which put numeric owner
     * and repository ids into `sub`. The form a token carries is decided by a
     * per-repository flag outside this codebase, and a `StringEquals` on the
     * wrong one fails closed with an unhelpful "Not authorized to perform
     * sts:AssumeRoleWithWebIdentity". Listing both exact strings tolerates the
     * migration in either direction without resorting to a wildcard.
     */
    const subjects = (suffix: string): string[] => {
      const [owner, name] = config.githubRepository.split("/");
      return [
        `repo:${config.githubRepository}:${suffix}`,
        `repo:${owner}@${config.githubOwnerId}/${name}@${config.githubRepositoryId}:${suffix}`,
      ];
    };

    const bootstrapRoles = `arn:aws:iam::${this.account}:role/cdk-${BOOTSTRAP_QUALIFIER}-*-${this.account}-${this.region}`;
    const bootstrapVersionParameter = `arn:aws:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/${BOOTSTRAP_QUALIFIER}/version`;

    // ------------------------------------------------------------ Deploy role
    this.deployRole = new iam.Role(this, "DeployRole", {
      roleName: `langflow-${config.envName}-github-deploy`,
      description: `cdk deploy for ${config.githubRepository} (${config.githubEnvironment} environment only)`,
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: "sts.amazonaws.com",
          [`${GITHUB_OIDC_HOST}:sub`]: subjects(`environment:${config.githubEnvironment}`),
        },
      }),
      // A cold first deploy builds the image and waits on Aurora; an hour is
      // not enough headroom.
      maxSessionDuration: Duration.hours(4),
    });

    // All real permissions come from the CDK bootstrap roles. This role only
    // holds the right to become them, so widening what the pipeline can do is a
    // change to the bootstrap stack rather than a quiet edit here.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: [bootstrapRoles],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadBootstrapVersion",
        actions: ["ssm:GetParameter"],
        resources: [bootstrapVersionParameter],
      }),
    );

    // -------------------------------------------------------------- Diff role
    this.diffRole = new iam.Role(this, "DiffRole", {
      roleName: `langflow-${config.envName}-github-diff`,
      description: `Read-only cdk diff for ${config.githubRepository}@${config.githubBranch}`,
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: "sts.amazonaws.com",
          [`${GITHUB_OIDC_HOST}:sub`]: subjects(`ref:refs/heads/${config.githubBranch}`),
        },
      }),
      maxSessionDuration: Duration.hours(1),
    });

    this.diffRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadDeployedTemplates",
        actions: [
          "cloudformation:DescribeStacks",
          "cloudformation:DescribeStackEvents",
          "cloudformation:DescribeStackResources",
          "cloudformation:GetTemplate",
          "cloudformation:GetStackPolicy",
          "cloudformation:ListStacks",
        ],
        resources: ["*"],
      }),
    );
    this.diffRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadBootstrapVersion",
        actions: ["ssm:GetParameter"],
        resources: [bootstrapVersionParameter],
      }),
    );
    // Context lookups (hosted zone, availability zones) run through the CDK
    // lookup role, which the bootstrap stack already restricts to reads. They
    // are normally served from the committed cdk.context.json.
    this.diffRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkLookupRole",
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:aws:iam::${this.account}:role/cdk-${BOOTSTRAP_QUALIFIER}-lookup-role-${this.account}-${this.region}`,
        ],
      }),
    );

    new CfnOutput(this, "DeployRoleArn", { value: this.deployRole.roleArn });
    new CfnOutput(this, "DiffRoleArn", { value: this.diffRole.roleArn });
  }
}

import { Annotations, Stack, type IAspect } from "aws-cdk-lib";
import { CfnSecurityGroup, CfnSecurityGroupIngress } from "aws-cdk-lib/aws-ec2";
import { CfnLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { CfnDBCluster } from "aws-cdk-lib/aws-rds";
import { CfnBucket } from "aws-cdk-lib/aws-s3";
import type { IConstruct } from "constructs";

/** Ports an internet-facing listener is allowed to expose. */
const PUBLIC_PORTS = new Set([80, 443]);
const ANY_IPV4 = "0.0.0.0/0";
const ANY_IPV6 = "::/0";

/**
 * Synth-time guardrails.
 *
 * These are the invariants that make the deployment private: nothing but the
 * load balancer's two web ports is reachable from the internet, no bucket is
 * public, and the database is encrypted. A future edit that loosens one of them
 * fails `cdk synth` instead of quietly shipping.
 */
export class SecurityChecks implements IAspect {
  public visit(node: IConstruct): void {
    if (node instanceof CfnSecurityGroup) {
      // Several L1 properties are lazily rendered, so read them through the
      // stack's resolver rather than off the construct.
      for (const rule of asArray(Stack.of(node).resolve(node.securityGroupIngress))) {
        this.checkIngress(node, rule);
      }
    }
    if (node instanceof CfnSecurityGroupIngress) {
      this.checkIngress(node, node);
    }
    if (node instanceof CfnBucket) {
      const block = Stack.of(node).resolve(node.publicAccessBlockConfiguration) as
        | { blockPublicAcls?: boolean; blockPublicPolicy?: boolean; ignorePublicAcls?: boolean; restrictPublicBuckets?: boolean }
        | undefined;
      const fullyBlocked =
        block?.blockPublicAcls === true &&
        block?.blockPublicPolicy === true &&
        block?.ignorePublicAcls === true &&
        block?.restrictPublicBuckets === true;
      if (!fullyBlocked) {
        Annotations.of(node).addError(
          "S3 bucket must block all public access (BlockPublicAccess.BLOCK_ALL).",
        );
      }
    }
    if (node instanceof CfnDBCluster) {
      if (node.storageEncrypted !== true) {
        Annotations.of(node).addError("Aurora cluster must set storageEncrypted: true.");
      }
    }
    if (node instanceof CfnLoadBalancer) {
      if (node.scheme === "internet-facing") {
        const attributes = asArray(
          Stack.of(node).resolve(node.loadBalancerAttributes),
        ) as Array<{
          key?: string;
          value?: string;
        }>;
        const logging = attributes.find((attribute) => attribute.key === "access_logs.s3.enabled");
        if (logging?.value !== "true") {
          Annotations.of(node).addError(
            "Internet-facing load balancer must have S3 access logging enabled.",
          );
        }
      }
    }
  }

  private checkIngress(node: IConstruct, rule: unknown): void {
    const { cidrIp, cidrIpv6, fromPort, toPort } = rule as {
      cidrIp?: string;
      cidrIpv6?: string;
      fromPort?: number;
      toPort?: number;
    };
    const isWorldReadable = cidrIp === ANY_IPV4 || cidrIpv6 === ANY_IPV6;
    if (!isWorldReadable) {
      return;
    }
    const ports = [fromPort, toPort].filter((port): port is number => typeof port === "number");
    const allowed = ports.length > 0 && ports.every((port) => PUBLIC_PORTS.has(port));
    if (!allowed) {
      Annotations.of(node).addError(
        `Security group rule opens ports ${ports.join("-") || "(all)"} to the internet. ` +
          "Only 80 and 443 on the load balancer may be public.",
      );
    }
  }
}

function asArray(value: unknown): unknown[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

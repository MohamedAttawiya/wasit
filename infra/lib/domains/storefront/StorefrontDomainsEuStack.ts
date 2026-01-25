// infra/lib/domains/storefront/StorefrontDomainsEuStack.ts
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";

export interface StorefrontDomainsEuStackProps extends cdk.StackProps {
  stage: string;

  /**
   * Root domain for storefronts.
   * Examples:
   *  - "cairoessentials.com" (recommended)
   *  - "dev.cairoessentials.com" (only if you intentionally want a sub-zone)
   */
  storefrontRootDomain: string;
}

export class StorefrontDomainsEuStack extends cdk.Stack {
  public readonly storefrontZone: route53.IHostedZone;
  public readonly storefrontHostedZoneId: string;
  public readonly storefrontRootDomain: string;

  public readonly storefrontWildcardHost: string; // "*.cairoessentials.com"

  constructor(scope: Construct, id: string, props: StorefrontDomainsEuStackProps) {
    super(scope, id, props);

    const stage = (props.stage ?? "dev").toLowerCase();

    this.storefrontRootDomain = props.storefrontRootDomain;
    this.storefrontWildcardHost = `*.${this.storefrontRootDomain}`;

    /**
     * Hosted Zone for storefront root.
     *
     * If you pass a subdomain like "dev.cairoessentials.com", Route53 will create a
     * separate hosted zone for that subdomain and you MUST delegate from the parent
     * hosted zone (cairoessentials.com) by creating NS records in the parent zone.
     */
    const zone = new route53.PublicHostedZone(this, "StorefrontZone", {
      zoneName: this.storefrontRootDomain,
    });

    this.storefrontZone = zone;
    this.storefrontHostedZoneId = zone.hostedZoneId;

    // Outputs
    new cdk.CfnOutput(this, "StorefrontStage", { value: stage });

    new cdk.CfnOutput(this, "StorefrontRootDomain", {
      value: this.storefrontRootDomain,
    });

    new cdk.CfnOutput(this, "StorefrontHostedZoneId", {
      value: this.storefrontHostedZoneId,
    });

    new cdk.CfnOutput(this, "StorefrontHostedZoneNameServers", {
      value: cdk.Fn.join(",", zone.hostedZoneNameServers ?? []),
    });

    new cdk.CfnOutput(this, "StorefrontWildcardHost", {
      value: this.storefrontWildcardHost,
    });
  }
}

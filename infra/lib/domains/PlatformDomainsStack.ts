import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

export interface PlatformDomainsStackProps extends cdk.StackProps {
  stage: string;

  // Only the root domain is provided by infra
  platformRootDomain: string; // e.g. "wasit-platform.shop"

  /**
   * Edge wildcard cert ARN already issued in us-east-1:
   *   *.wasit-platform.shop
   *
   * This stack DOES NOT create it (single-stack constraint).
   * It only consumes and outputs it as part of the contract.
   */
  platformWildcardCertArnUsEast1: string;
}

export class PlatformDomainsStack extends cdk.Stack {
  // Hosted zone
  public readonly platformZone: route53.IHostedZone;

  // These names match what your infra.ts expects
  public readonly platformRootDomain: string;
  public readonly platformHostedZoneId: string;

  // Stable hosts (stack contract)
  public readonly adminHost: string;
  public readonly authHost: string;
  public readonly apiHost: string;
  public readonly internalHost: string;

  // Cert ARNs (stack contract)
  public readonly wildcardCertArnUsEast1: string;
  public readonly apiCertArnRegional: string;

  constructor(scope: Construct, id: string, props: PlatformDomainsStackProps) {
    super(scope, id, props);

    this.platformRootDomain = props.platformRootDomain;

    // ----------------------------
    // Minimum required subdomains (owned by the stack)
    // ----------------------------
    const ADMIN_SUBDOMAIN = "admin";
    const AUTH_SUBDOMAIN = "auth";
    const API_SUBDOMAIN = "api";
    const INTERNAL_SUBDOMAIN = "internal";

    // Stable host strings
    this.adminHost = `${ADMIN_SUBDOMAIN}.${props.platformRootDomain}`;
    this.authHost = `${AUTH_SUBDOMAIN}.${props.platformRootDomain}`;
    this.apiHost = `${API_SUBDOMAIN}.${props.platformRootDomain}`;
    this.internalHost = `${INTERNAL_SUBDOMAIN}.${props.platformRootDomain}`;

    // ----------------------------
    // Hosted zone (authoritative)
    // ----------------------------
    const zone = new route53.PublicHostedZone(this, "PlatformZone", {
      zoneName: props.platformRootDomain,
    });

    this.platformZone = zone;
    this.platformHostedZoneId = zone.hostedZoneId;

    // ----------------------------
    // Certificates
    // ----------------------------

    /**
     * Edge wildcard cert (us-east-1) is NOT created here.
     * We import its ARN (already issued) and expose it to downstream stacks.
     */
    this.wildcardCertArnUsEast1 = props.platformWildcardCertArnUsEast1;

    /**
     * Regional cert for API Gateway custom domain:
     * api.<platformRoot>
     *
     * Must be created in the same region as the API Gateway domain
     * (your primary region, e.g. eu-central-1).
     */
    const apiCert = new acm.Certificate(this, "ApiCertRegional", {
      domainName: this.apiHost,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    this.apiCertArnRegional = apiCert.certificateArn;

    // ----------------------------
    // Outputs (contract for downstream layers)
    // ----------------------------
    new cdk.CfnOutput(this, "PlatformHostedZoneId", {
      value: zone.hostedZoneId,
    });

    new cdk.CfnOutput(this, "PlatformHostedZoneNameServers", {
      value: cdk.Fn.join(",", zone.hostedZoneNameServers ?? []),
    });

    new cdk.CfnOutput(this, "PlatformRootDomain", {
      value: props.platformRootDomain,
    });

    new cdk.CfnOutput(this, "AdminHost", { value: this.adminHost });
    new cdk.CfnOutput(this, "AuthHost", { value: this.authHost });
    new cdk.CfnOutput(this, "ApiHost", { value: this.apiHost });
    new cdk.CfnOutput(this, "InternalHost", { value: this.internalHost });

    new cdk.CfnOutput(this, "WildcardCertArnUsEast1", {
      value: this.wildcardCertArnUsEast1,
    });

    new cdk.CfnOutput(this, "ApiCertArnRegional", {
      value: this.apiCertArnRegional,
    });
  }
}

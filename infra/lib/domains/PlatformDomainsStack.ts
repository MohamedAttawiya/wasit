import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

export interface PlatformDomainsStackProps extends cdk.StackProps {
  stage: string;

  // Only the root domain is provided by infra
  platformRootDomain: string; // e.g. "wasit-platform.shop"
}

export class PlatformDomainsStack extends cdk.Stack {
  // Hosted zone
  public readonly platformZone: route53.IHostedZone;

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

    // ----------------------------
    // Certificates
    // ----------------------------

    /**
     * Shared EDGE cert (CloudFront + Cognito + internal tools)
     * Covers:
     *   admin.*
     *   auth.*
     *   internal.*
     */
    const wildcardCert = new acm.DnsValidatedCertificate(
      this,
      "PlatformWildcardCertUsEast1",
      {
        domainName: `*.${props.platformRootDomain}`,
        hostedZone: zone,
        region: "us-east-1",
      }
    );
    this.wildcardCertArnUsEast1 = wildcardCert.certificateArn;

    /**
     * API Gateway custom domain cert (regional)
     * api.<platformRoot>
     */
    const apiCert = new acm.DnsValidatedCertificate(
      this,
      "ApiCertRegional",
      {
        domainName: this.apiHost,
        hostedZone: zone,
        // created in stack region (eu-central-1)
      }
    );
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

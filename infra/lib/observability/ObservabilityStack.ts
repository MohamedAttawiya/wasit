import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as glue from "aws-cdk-lib/aws-glue";
import * as athena from "aws-cdk-lib/aws-athena";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as path from "path";

export interface ObservabilityStackProps extends cdk.StackProps {
  prefix: string; // naming only
  stage: string;  // authoritative env: dev | prod | ...
}



export class ObservabilityStack extends cdk.Stack {
  public readonly logArchiveBucket: s3.Bucket;
  public readonly logDeliveryStreamArn: string;
  public readonly logDeliveryStreamName: string;

  public readonly glueDatabaseName: string;
  public readonly glueTableName: string;
  public readonly athenaWorkGroupName: string;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

 const envName = props.stage.toLowerCase();

    // ---------- S3: durable log archive ----------
    this.logArchiveBucket = new s3.Bucket(this, "LogArchiveBucket", {
      bucketName: `${props.prefix}-logs-${this.account}-${this.region}`.toLowerCase(),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,

      // dev-friendly
      versioned: false,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---------- Athena results bucket ----------
    const athenaResultsBucket = new s3.Bucket(this, "AthenaResultsBucket", {
      bucketName: `${props.prefix}-athena-${this.account}-${this.region}`.toLowerCase(),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,

      versioned: false,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---------- Firehose role ----------
    const firehoseRole = new iam.Role(this, "FirehoseRole", {
      assumedBy: new iam.ServicePrincipal("firehose.amazonaws.com"),
      description: "Allows Firehose to write log objects into the archive bucket",
    });

    this.logArchiveBucket.grantReadWrite(firehoseRole);
    firehoseRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetBucketLocation", "s3:ListBucket"],
        resources: [this.logArchiveBucket.bucketArn],
      })
    );

    // ---------- Processor Lambda (asset-backed) ----------
    const cwToNdjsonFn = new lambda.Function(this, "CwToNdjsonFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "..", "lambda", "observability")),
      environment: {
        DEFAULT_ENV: envName,
      },
    });

    firehoseRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction", "lambda:GetFunctionConfiguration"],
        resources: [cwToNdjsonFn.functionArn],
      })
    );

    // ---------- Firehose ----------
    const prefix =
      "env=!{partitionKeyFromLambda:env}/service=!{partitionKeyFromLambda:service}/date=!{timestamp:yyyy-MM-dd}/";
  const errorPrefix =
    "error/date=!{timestamp:yyyy-MM-dd}/!{firehose:error-output-type}/";

    const streamName = `${props.prefix}-central-logs`.toLowerCase();
    this.logDeliveryStreamName = streamName;

    const stream = new firehose.CfnDeliveryStream(this, "CentralLogDeliveryStream", {
      deliveryStreamName: streamName,
      deliveryStreamType: "DirectPut",
      extendedS3DestinationConfiguration: {
        bucketArn: this.logArchiveBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        prefix,
        errorOutputPrefix: errorPrefix,
        compressionFormat: "GZIP",
        bufferingHints: { intervalInSeconds: 60, sizeInMBs: 64 },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: "Lambda",
              parameters: [
                { parameterName: "LambdaArn", parameterValue: cwToNdjsonFn.functionArn },
                { parameterName: "NumberOfRetries", parameterValue: "2" },
              ],
            },
          ],
        },
        dynamicPartitioningConfiguration: {
          enabled: true,
          retryOptions: { durationInSeconds: 300 },
        },
      },
    });

    this.logDeliveryStreamArn = stream.attrArn;

    // ============================================================
    // SSM: publish well-known parameters for other stacks
    // ============================================================
    const baseParamPath = `/${props.prefix}/observability`;

    new ssm.StringParameter(this, "ObsFirehoseArnParam", {
      parameterName: `${baseParamPath}/logDeliveryStreamArn`,
      stringValue: this.logDeliveryStreamArn,
      description: "Central logs Firehose delivery stream ARN",
    });

    new ssm.StringParameter(this, "ObsFirehoseNameParam", {
      parameterName: `${baseParamPath}/logDeliveryStreamName`,
      stringValue: this.logDeliveryStreamName,
      description: "Central logs Firehose delivery stream name",
    });

    new ssm.StringParameter(this, "ObsLogBucketNameParam", {
      parameterName: `${baseParamPath}/logArchiveBucketName`,
      stringValue: this.logArchiveBucket.bucketName,
      description: "Central logs archive bucket name",
    });

    new ssm.StringParameter(this, "ObsLogBucketArnParam", {
      parameterName: `${baseParamPath}/logArchiveBucketArn`,
      stringValue: this.logArchiveBucket.bucketArn,
      description: "Central logs archive bucket ARN",
    });

    // ============================================================
    // Glue / Athena
    // ============================================================
    this.glueDatabaseName = `${props.prefix.replace(/[^a-zA-Z0-9_]/g, "_")}_logs`.toLowerCase();

    const db = new glue.CfnDatabase(this, "LogsDatabase", {
      catalogId: this.account,
      databaseInput: {
        name: this.glueDatabaseName,
        description: "Wasit logs (flattened log events as NDJSON in S3)",
      },
    });

    this.glueTableName = "log_events";

    const table = new glue.CfnTable(this, "LogEventsTable", {
      catalogId: this.account,
      databaseName: this.glueDatabaseName,
      tableInput: {
        name: this.glueTableName,
        tableType: "EXTERNAL_TABLE",
        parameters: {
          classification: "json",
          "ignore.malformed.json": "true",
          "projection.enabled": "false",
        },
        partitionKeys: [
          { name: "env", type: "string" },
          { name: "service", type: "string" },
          { name: "date", type: "string" },
        ],
        storageDescriptor: {
          location: `s3://${this.logArchiveBucket.bucketName}/`,
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          compressed: true,
          serdeInfo: {
            serializationLibrary: "org.openx.data.jsonserde.JsonSerDe",
            parameters: {
              "ignore.malformed.json": "true",
              "case.insensitive": "true",
            },
          },
          columns: [
            { name: "ts", type: "bigint" },
            { name: "level", type: "string" },
            { name: "correlationId", type: "string" },
            { name: "msg", type: "string" },
            { name: "details", type: "string" },
            { name: "cw", type: "struct<logGroup:string,logStream:string,id:string,cwTimestamp:bigint>" },
          ],
        },
      },
    });

    table.addDependency(db);

    this.athenaWorkGroupName = `${props.prefix}-wg`.toLowerCase();

    new athena.CfnWorkGroup(this, "AthenaWorkGroup", {
      name: this.athenaWorkGroupName,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        resultConfiguration: {
          outputLocation: `s3://${athenaResultsBucket.bucketName}/results/`,
        },
      },
    });

    // ---------- Outputs ----------
    new cdk.CfnOutput(this, "LogArchiveBucketName", { value: this.logArchiveBucket.bucketName });
    new cdk.CfnOutput(this, "LogArchiveBucketArn", { value: this.logArchiveBucket.bucketArn });
    new cdk.CfnOutput(this, "CentralLogDeliveryStreamName", { value: this.logDeliveryStreamName });
    new cdk.CfnOutput(this, "CentralLogDeliveryStreamArn", { value: this.logDeliveryStreamArn });
    new cdk.CfnOutput(this, "AthenaResultsBucketName", { value: athenaResultsBucket.bucketName });
    new cdk.CfnOutput(this, "GlueDatabaseName", { value: this.glueDatabaseName });
    new cdk.CfnOutput(this, "GlueTableName", { value: this.glueTableName });
    new cdk.CfnOutput(this, "AthenaWorkGroupName", { value: this.athenaWorkGroupName });

    // Optional: output the base SSM path so humans know where to look
    new cdk.CfnOutput(this, "ObservabilitySsmBasePath", { value: baseParamPath });
  }
}

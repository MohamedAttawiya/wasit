import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as glue from "aws-cdk-lib/aws-glue";
import * as athena from "aws-cdk-lib/aws-athena";
import * as lambda from "aws-cdk-lib/aws-lambda";

export interface ObservabilityStackProps extends cdk.StackProps {
  prefix: string;
  envName?: string; // default: "dev"
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

    const envName = (props.envName ?? "dev").toLowerCase();

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

    // ---------- Athena results bucket (keep separate from logs) ----------
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

    // ---------- Firehose role: can write to S3 ----------
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

    // ---------- Processor Lambda: gunzip CloudWatch payload -> NDJSON ----------
    // CloudWatch Logs subscription payload arrives gzipped (binary). Athena needs text JSON.
    const cwDecompressFn = new lambda.Function(this, "CwLogsDecompressFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      code: lambda.Code.fromInline(`
        const zlib = require("zlib");

        exports.handler = async (event) => {
          const records = event.records.map((r) => {
            try {
              const buf = Buffer.from(r.data, "base64");
              const json = zlib.gunzipSync(buf).toString("utf8");

              // Ensure NDJSON (one JSON object per line)
              const out = json.endsWith("\\n") ? json : (json + "\\n");

              return {
                recordId: r.recordId,
                result: "Ok",
                data: Buffer.from(out, "utf8").toString("base64"),
              };
            } catch (e) {
              return {
                recordId: r.recordId,
                result: "ProcessingFailed",
                data: r.data,
              };
            }
          });

          return { records };
        };
      `),
    });

    // Firehose must be allowed to invoke the processor Lambda
    firehoseRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction", "lambda:GetFunctionConfiguration"],
        resources: [cwDecompressFn.functionArn],
      })
    );

    // ---------- Firehose: DirectPut -> ExtendedS3 ----------
    // Write NDJSON (optionally gzip the *file*, which Athena supports)
    const prefix = `env=${envName}/service=unknown/date=!{timestamp:yyyy-MM-dd}/`;
    const errorPrefix = `env=${envName}/service=unknown/error/date=!{timestamp:yyyy-MM-dd}/!{firehose:error-output-type}/`;

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

        // ✅ file-level gzip is fine; content is text NDJSON after processor
        compressionFormat: "GZIP",

        bufferingHints: { intervalInSeconds: 60, sizeInMBs: 5 },

        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: "Lambda",
              parameters: [
                { parameterName: "LambdaArn", parameterValue: cwDecompressFn.functionArn },
                { parameterName: "NumberOfRetries", parameterValue: "2" },
              ],
            },
            {
              type: "AppendDelimiterToRecord",
              parameters: [{ parameterName: "Delimiter", parameterValue: "\\n" }],
            },
          ],
        },
      },
    });

    this.logDeliveryStreamArn = stream.attrArn;

    // ============================================================
    // Glue / Athena (minimal, no crawler)
    // ============================================================

    this.glueDatabaseName = `${props.prefix.replace(/[^a-zA-Z0-9_]/g, "_")}_logs`.toLowerCase();

    const db = new glue.CfnDatabase(this, "LogsDatabase", {
      catalogId: this.account,
      databaseInput: {
        name: this.glueDatabaseName,
        description: "Wasit logs (CloudWatch subscription payloads -> NDJSON in S3)",
      },
    });

    this.glueTableName = "cw_subscription";

    const table = new glue.CfnTable(this, "CwSubscriptionTable", {
      catalogId: this.account,
      databaseName: this.glueDatabaseName,
      tableInput: {
        name: this.glueTableName,
        tableType: "EXTERNAL_TABLE",
        parameters: {
          classification: "json",
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

          // ✅ file-level gzip
          compressed: true,

          serdeInfo: {
            serializationLibrary: "org.openx.data.jsonserde.JsonSerDe",
            parameters: {
              "ignore.malformed.json": "true",
              "case.insensitive": "true",
            },
          },

          // Note: match JSON keys (your payload uses camelCase)
          columns: [
            { name: "messageType", type: "string" },
            { name: "owner", type: "string" },
            { name: "logGroup", type: "string" },
            { name: "logStream", type: "string" },
            { name: "subscriptionFilters", type: "array<string>" },
            {
              name: "logEvents",
              type: "array<struct<id:string,timestamp:bigint,message:string>>",
            },
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
    new cdk.CfnOutput(this, "LogArchiveBucketName", {
      value: this.logArchiveBucket.bucketName,
    });

    new cdk.CfnOutput(this, "CentralLogDeliveryStreamName", {
      value: this.logDeliveryStreamName,
    });

    new cdk.CfnOutput(this, "CentralLogDeliveryStreamArn", {
      value: this.logDeliveryStreamArn,
    });

    new cdk.CfnOutput(this, "AthenaResultsBucketName", {
      value: athenaResultsBucket.bucketName,
    });

    new cdk.CfnOutput(this, "GlueDatabaseName", {
      value: this.glueDatabaseName,
    });

    new cdk.CfnOutput(this, "GlueTableName", {
      value: this.glueTableName,
    });

    new cdk.CfnOutput(this, "AthenaWorkGroupName", {
      value: this.athenaWorkGroupName,
    });
  }
}

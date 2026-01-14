import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";

export interface DataStackProps extends cdk.StackProps {
  prefix: string;
}

export class DataStack extends cdk.Stack {
  public readonly eventBus: events.EventBus;

  public readonly storesTable: dynamodb.Table;
  public readonly productsTable: dynamodb.Table;
  public readonly storeProductsTable: dynamodb.Table;

  public readonly ordersTable: dynamodb.Table;
  public readonly orderItemsTable: dynamodb.Table;

  public readonly inventoryTable: dynamodb.Table;
  public readonly fulfillmentJobsTable: dynamodb.Table;

  public readonly customerPaymentsTable: dynamodb.Table;
  public readonly ledgerEntriesTable: dynamodb.Table;
  public readonly sellerSettlementsTable: dynamodb.Table;
  public readonly refundsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // ========= Event Bus =========
    this.eventBus = new events.EventBus(this, "EventBus", {
      eventBusName: `${props.prefix}-bus`,
    });

    // ========= Stores =========
    this.storesTable = new dynamodb.Table(this, "StoresTable", {
      tableName: "stores",
      partitionKey: { name: "storeId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "recordType", type: dynamodb.AttributeType.STRING }, // META
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev
    });

    this.storesTable.addGlobalSecondaryIndex({
      indexName: "gsi_hostname",
      partitionKey: { name: "hostname", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "storeId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========= Products (Atomic SKUs) =========
    this.productsTable = new dynamodb.Table(this, "ProductsTable", {
      tableName: "products",
      partitionKey: { name: "productId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "recordType", type: dynamodb.AttributeType.STRING }, // META
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev
    });

    this.productsTable.addGlobalSecondaryIndex({
      indexName: "gsi_category_status",
      partitionKey: { name: "category", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "status", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========= StoreProducts (store-specific pricing + publish state) =========
    // PK=storeId, SK=PROD#<productId> (we keep attribute name "productId" as per your doc usage)
    this.storeProductsTable = new dynamodb.Table(this, "StoreProductsTable", {
      tableName: "store_products",
      partitionKey: { name: "storeId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "productId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev
    });

    // Reverse lookup: product -> which stores carry it
    this.storeProductsTable.addGlobalSecondaryIndex({
      indexName: "gsi_product",
      partitionKey: { name: "productId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "storeId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========= Orders =========
    this.ordersTable = new dynamodb.Table(this, "OrdersTable", {
      tableName: "orders",
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "recordType", type: dynamodb.AttributeType.STRING }, // META
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev
    });

    // Seller/ops lookup: store -> orders (time ordered)
    this.ordersTable.addGlobalSecondaryIndex({
      indexName: "gsi_store",
      partitionKey: { name: "storeId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Ops queues: status -> orders
    this.ordersTable.addGlobalSecondaryIndex({
      indexName: "gsi_status",
      partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========= Order Items =========
    this.orderItemsTable = new dynamodb.Table(this, "OrderItemsTable", {
      tableName: "order_items",
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "orderItemId", type: dynamodb.AttributeType.STRING }, // ITEM#<id>
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev
    });

    // Optional investigations: product -> order items
    this.orderItemsTable.addGlobalSecondaryIndex({
      indexName: "gsi_product",
      partitionKey: { name: "productId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========= Inventory (stock + reservations) =========
    // PK=productId, SK=recordType where recordType is LOC#<id> or RSV#<id>
    // Reservation items should include expiresAt and you can TTL them by enabling TTL on attribute "expiresAt".
    this.inventoryTable = new dynamodb.Table(this, "InventoryTable", {
      tableName: "inventory",
      partitionKey: { name: "productId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "recordType", type: dynamodb.AttributeType.STRING }, // LOC#/RSV#
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev
    });

    // Release reservations by orderId
    this.inventoryTable.addGlobalSecondaryIndex({
      indexName: "gsi_order",
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "productId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // TTL only applies to reservation records that set expiresAt
    this.inventoryTable.addTimeToLiveAttribute("expiresAt");

    // ========= Fulfillment Jobs =========
    this.fulfillmentJobsTable = new dynamodb.Table(this, "FulfillmentJobsTable", {
      tableName: "fulfillment_jobs",
      partitionKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "recordType", type: dynamodb.AttributeType.STRING }, // META
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev
    });

    // Order -> jobs
    this.fulfillmentJobsTable.addGlobalSecondaryIndex({
      indexName: "gsi_order",
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Ops queue: status + type
    this.fulfillmentJobsTable.addGlobalSecondaryIndex({
      indexName: "gsi_status_type",
      partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "type", type: dynamodb.AttributeType.STRING }, // INVENTORY/POD
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========= Customer Payments =========
    this.customerPaymentsTable = new dynamodb.Table(this, "CustomerPaymentsTable", {
      tableName: "customer_payments",
      partitionKey: { name: "paymentId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "recordType", type: dynamodb.AttributeType.STRING }, // META
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev
    });

    // Order reconciliation
    this.customerPaymentsTable.addGlobalSecondaryIndex({
      indexName: "gsi_order",
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========= Ledger Entries (append-only) =========
    this.ledgerEntriesTable = new dynamodb.Table(this, "LedgerEntriesTable", {
      tableName: "ledger_entries",
      partitionKey: { name: "ledgerEntryId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "recordType", type: dynamodb.AttributeType.STRING }, // META
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev
    });

    // Financial trace per order
    this.ledgerEntriesTable.addGlobalSecondaryIndex({
      indexName: "gsi_order",
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========= Seller Settlements =========
    this.sellerSettlementsTable = new dynamodb.Table(this, "SellerSettlementsTable", {
      tableName: "seller_settlements",
      partitionKey: { name: "settlementId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "recordType", type: dynamodb.AttributeType.STRING }, // META
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev
    });

    // Seller payout history
    this.sellerSettlementsTable.addGlobalSecondaryIndex({
      indexName: "gsi_seller",
      partitionKey: { name: "sellerId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========= Refunds =========
    this.refundsTable = new dynamodb.Table(this, "RefundsTable", {
      tableName: "refunds",
      partitionKey: { name: "refundId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "recordType", type: dynamodb.AttributeType.STRING }, // META
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev
    });

    this.refundsTable.addGlobalSecondaryIndex({
      indexName: "gsi_order",
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========= Outputs =========
    new cdk.CfnOutput(this, "EventBusName", { value: this.eventBus.eventBusName });

    new cdk.CfnOutput(this, "StoresTableName", { value: this.storesTable.tableName });
    new cdk.CfnOutput(this, "ProductsTableName", { value: this.productsTable.tableName });
    new cdk.CfnOutput(this, "StoreProductsTableName", { value: this.storeProductsTable.tableName });

    new cdk.CfnOutput(this, "OrdersTableName", { value: this.ordersTable.tableName });
    new cdk.CfnOutput(this, "OrderItemsTableName", { value: this.orderItemsTable.tableName });

    new cdk.CfnOutput(this, "InventoryTableName", { value: this.inventoryTable.tableName });
    new cdk.CfnOutput(this, "FulfillmentJobsTableName", { value: this.fulfillmentJobsTable.tableName });

    new cdk.CfnOutput(this, "CustomerPaymentsTableName", { value: this.customerPaymentsTable.tableName });
    new cdk.CfnOutput(this, "LedgerEntriesTableName", { value: this.ledgerEntriesTable.tableName });
    new cdk.CfnOutput(this, "SellerSettlementsTableName", { value: this.sellerSettlementsTable.tableName });
    new cdk.CfnOutput(this, "RefundsTableName", { value: this.refundsTable.tableName });
  }
}

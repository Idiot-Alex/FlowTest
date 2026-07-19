import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface Order {
  id: string;
  customerName: string;
  productName: string;
  quantity: number;
  status: "PENDING";
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function sendHtml(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>FlowTest Demo</title></head>
<body><main>${body}</main></body>
</html>`);
}

export async function startDemoServer(port = 4173): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const orders = new Map<string, Order>();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/orders/new") {
        sendHtml(
          response,
          200,
          `<h1>创建订单</h1>
<form method="post" action="/orders">
  <label for="customer-name">客户名称</label>
  <input id="customer-name" data-testid="customer-name" name="customerName" required>
  <label for="product-name">产品</label>
  <select id="product-name" data-testid="product-name" name="productName">
    <option>标准套餐</option>
    <option>企业套餐</option>
  </select>
  <label for="quantity">数量</label>
  <input id="quantity" data-testid="quantity" name="quantity" type="number" min="1" required>
  <button data-testid="submit-order" type="submit">保存订单</button>
</form>`,
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/orders") {
        const form = new URLSearchParams(await readBody(request));
        const order: Order = {
          id: randomUUID().slice(0, 8),
          customerName: form.get("customerName") ?? "",
          productName: form.get("productName") ?? "",
          quantity: Number(form.get("quantity") ?? 0),
          status: "PENDING",
        };
        orders.set(order.id, order);
        response.writeHead(303, { location: `/orders/${order.id}` });
        response.end();
        return;
      }

      const orderPageMatch = /^\/orders\/([a-z0-9-]+)$/.exec(url.pathname);
      if (request.method === "GET" && orderPageMatch?.[1] !== undefined) {
        const order = orders.get(orderPageMatch[1]);
        if (order === undefined) {
          sendHtml(response, 404, "<h1>订单不存在</h1>");
          return;
        }
        sendHtml(
          response,
          200,
          `<h1>订单详情</h1>
<dl>
  <dt>客户</dt><dd data-testid="customer">${htmlEscape(order.customerName)}</dd>
  <dt>产品</dt><dd data-testid="product">${htmlEscape(order.productName)}</dd>
  <dt>数量</dt><dd data-testid="quantity">${order.quantity}</dd>
  <dt>状态</dt><dd data-testid="order-status">待审批</dd>
</dl>`,
        );
        return;
      }

      const apiMatch = /^\/api\/orders\/([a-z0-9-]+)$/.exec(url.pathname);
      if (apiMatch?.[1] !== undefined && request.method === "GET") {
        const order = orders.get(apiMatch[1]);
        if (order === undefined) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        sendJson(response, 200, { data: order });
        return;
      }

      if (apiMatch?.[1] !== undefined && request.method === "DELETE") {
        orders.delete(apiMatch[1]);
        response.writeHead(204);
        response.end();
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      }),
  };
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  const port = Number(process.env.FLOWTEST_DEMO_PORT ?? 4173);
  const demo = await startDemoServer(port);
  console.log(`FlowTest demo app: ${demo.baseUrl}`);
  const stop = async (): Promise<void> => {
    await demo.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

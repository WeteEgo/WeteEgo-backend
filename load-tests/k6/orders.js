import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.API_URL || "http://localhost:3001";

export const options = {
  scenarios: {
    orders: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 100 },
        { duration: "10m", target: 100 },
      ],
      startTime: "0s",
      gracefulRampDown: "30s",
      exec: "createOrder",
    },
  },
  thresholds: {
    http_req_duration: ["p(99)<5000"],
    http_req_failed: ["rate<0.001"],
  },
};

export function createOrder() {
  const payload = JSON.stringify({
    walletAddress: "0x0000000000000000000000000000000000000001",
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amount: "10000000",
    fiatCurrency: "NGN",
  });
  const res = http.post(`${BASE}/api/orders`, payload, {
    headers: { "Content-Type": "application/json" },
  });
  check(res, { "status 201 or 429": (r) => r.status === 201 || r.status === 429 });
  sleep(1);
}

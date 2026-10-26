import type { FaucetApi } from "../preload/index.ts";

declare global {
  interface Window {
    faucet: FaucetApi;
  }
}

const out = document.getElementById("result");
if (out) {
  window.faucet
    .smoke()
    .then((result) => {
      out.textContent = JSON.stringify(result, null, 2);
      out.dataset["status"] = "done";
    })
    .catch((err: unknown) => {
      out.textContent = String(err);
      out.dataset["status"] = "error";
    });
}

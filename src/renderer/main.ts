import type { WinnowApi } from "../preload/index.ts";

declare global {
  interface Window {
    winnow: WinnowApi;
  }
}

const out = document.getElementById("result");
if (out) {
  window.winnow
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

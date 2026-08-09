"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const bengaluruAddresses = [
  "Salarpuria Greenage, Hosur Road, Bengaluru",
  "Greenage, Hosur Road, Bengaluru",
  "Indiranagar, Bengaluru",
  "Koramangala, Bengaluru",
  "HSR Layout, Bengaluru",
  "Whitefield, Bengaluru",
  "JP Nagar, Bengaluru",
  "Jayanagar, Bengaluru",
  "Bellandur, Bengaluru",
  "Sarjapur Road, Bengaluru",
  "Electronic City, Bengaluru",
  "Marathahalli, Bengaluru",
];

function enhanceAddressInputs() {
  let list = document.getElementById("pawspace-bengaluru-addresses") as HTMLDataListElement | null;
  if (!list) {
    list = document.createElement("datalist");
    list.id = "pawspace-bengaluru-addresses";
    for (const value of bengaluruAddresses) {
      const option = document.createElement("option");
      option.value = value;
      list.appendChild(option);
    }
    document.body.appendChild(list);
  }

  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
  for (const input of inputs) {
    const label = input.closest("label")?.textContent?.toLowerCase() || "";
    const placeholder = input.placeholder.toLowerCase();
    const isAddress = label.includes("address") || placeholder.includes("address") || placeholder.includes("location");
    if (!isAddress) continue;
    input.setAttribute("list", list.id);
    input.setAttribute("autocomplete", "street-address");
    input.setAttribute("spellcheck", "false");
    if (!input.placeholder.toLowerCase().includes("greenage")) {
      input.placeholder = "Start typing address, e.g. Greenage, HSR Layout, Indiranagar";
    }
  }
}

function hideCustomerTestPanels() {
  const customerPaths = new Set(["/", "/mobile-app", "/grooming", "/boarding", "/sitting", "/training", "/walking", "/food", "/relocation", "/funeral-memorial"]);
  if (!customerPaths.has(window.location.pathname)) return;
  document.querySelectorAll<HTMLElement>("[data-surface='customer']").forEach((node) => {
    node.style.display = "none";
    node.setAttribute("aria-hidden", "true");
  });
}

export default function ReviewUxFixes() {
  const pathname = usePathname();

  useEffect(() => {
    document.body.classList.toggle("route-control", pathname === "/control");
    document.body.classList.toggle("route-mobile-app", pathname === "/mobile-app");
    enhanceAddressInputs();
    hideCustomerTestPanels();

    const observer = new MutationObserver(() => {
      enhanceAddressInputs();
      hideCustomerTestPanels();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pathname]);

  return null;
}

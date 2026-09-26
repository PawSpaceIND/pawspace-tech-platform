import React from "react";

/*
 * recharts is CommonJS that requires the ESM-only redux toolkit, which neither the registerHooks nor the
 * loader path can link ("request for 'redux' is from a module not been linked"). Charts draw nothing in
 * renderToStaticMarkup anyway (ResponsiveContainer measures the DOM), so a page that shows a chart is
 * rendered with plain elements in its place. The numbers and labels a test asserts on live outside the chart.
 */
const element = (name) => function RechartsStub({ children }) {
  return React.createElement("div", { "data-recharts-stub": name }, children);
};

export const ResponsiveContainer = element("ResponsiveContainer");
export const LineChart = element("LineChart");
export const BarChart = element("BarChart");
export const Line = element("Line");
export const Bar = element("Bar");
export const XAxis = element("XAxis");
export const YAxis = element("YAxis");
export const CartesianGrid = element("CartesianGrid");
export const Tooltip = element("Tooltip");
export const Legend = element("Legend");

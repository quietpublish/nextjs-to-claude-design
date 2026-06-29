// A compound component: a root plus parts that must all reach the design
// namespace so a design can compose <Panel><PanelHeader>…</PanelHeader></Panel>.
import React from "react";

export function Panel({ children }: { children?: React.ReactNode }) {
  return <section className="panel">{children}</section>;
}

export function PanelHeader({ children }: { children?: React.ReactNode }) {
  return <header className="panel-header">{children}</header>;
}

export function PanelBody({ children }: { children?: React.ReactNode }) {
  return <div className="panel-body">{children}</div>;
}

// a non-component named export (camelCase) — must NOT be exposed as a part
export const panelClass = "panel";

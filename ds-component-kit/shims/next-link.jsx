// Design-runtime shim for next/link — renders a plain anchor. Navigation is
// inert in the design canvas; href is preserved so the link still reads right.
import React from "react";

export default function Link({ href, children, prefetch, replace, scroll, ...rest }) {
  return (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  );
}

// Design-runtime shim for next/dynamic — React.lazy + Suspense with the same
// `loading` fallback, so dynamically-imported components still render.
import React from "react";

export default function dynamic(loader, options = {}) {
  const Lazy = React.lazy(loader);
  const Loading = options.loading || (() => null);
  return function Dynamic(props) {
    return React.createElement(
      React.Suspense,
      { fallback: React.createElement(Loading) },
      React.createElement(Lazy, props),
    );
  };
}

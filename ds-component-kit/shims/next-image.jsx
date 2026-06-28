// Design-runtime shim for next/image — plain <img>, no optimizer pipeline.
import React from "react";

export default function Image({ src, alt = "", width, height, fill, priority, ...rest }) {
  const style = fill
    ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", ...rest.style }
    : rest.style;
  return <img src={typeof src === "string" ? src : src?.src} alt={alt} width={width} height={height} {...rest} style={style} />;
}

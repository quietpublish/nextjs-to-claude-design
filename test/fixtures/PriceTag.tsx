"use client";
import Link from "next/link";
import { usd, type Cents } from "./format";
import styles from "./PriceTag.module.css";

type Props = { cents: Cents; href?: string };

export default function PriceTag({ cents, href = "#" }: Props) {
  return (
    <Link href={href} className={styles.tag}>
      <span className={styles.amount}>{usd(cents)}</span>
    </Link>
  );
}

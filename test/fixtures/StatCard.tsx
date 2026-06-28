import styles from "./StatCard.module.css";

type Props = { label?: string; value?: string };

export default function StatCard({ label = "Revenue", value = "$1,200" }: Props) {
  return (
    <div className={styles.card}>
      <span className={styles.label}>{label}</span>
      <strong className={styles.value}>{value}</strong>
    </div>
  );
}

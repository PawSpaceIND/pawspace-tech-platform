import RecoveryScreen from "./components/recovery-screen";

export default function NotFound() {
  return (
    <RecoveryScreen
      title="We couldn't find that page"
      detail="The link may be out of date, or the page may have moved. Everything else is where you left it."
    />
  );
}

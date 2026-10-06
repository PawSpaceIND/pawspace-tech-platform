import { NativeServiceArt } from "./native-art";
/** Non-blocking brand animation; does not delay, redirect or request permissions. */
export default function PawSpaceWelcome() {
  return <div className="paw-welcome" aria-hidden="true">
    <div className="paw-welcome-inner">
      <div className="paw-welcome-pets"><NativeServiceArt service="family" /></div>
      <img className="paw-welcome-logo" src="/assets/pawspace-official-lockup.png" alt="" />
      <p>Little paws. A world of care.</p>
      <span className="paw-welcome-dots">● ● ●</span>
    </div>
  </div>;
}

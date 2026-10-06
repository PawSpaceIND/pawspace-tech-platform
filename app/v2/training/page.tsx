import {NativeServiceArt} from "../../components/native-art";
import TrainingPage from "../../training/page";
import styles from "./training-discovery.module.css";
export default function V2TrainingPage(){return <><section className={styles.hero} aria-label="Training together"><div><small>LEARN TOGETHER</small><h2>Small steps.<br/>A stronger bond.</h2><p>Start with what your dog needs. Compare programmes, then review your trainer and every session before reserving.</p><a href="#training-programmes">Explore training programmes ↓</a></div><NativeServiceArt service="dog_training" informative className={styles.heroScene}/></section><div id="training-programmes" className={styles.programmes}><TrainingPage routeScope="v2"/></div></>;}

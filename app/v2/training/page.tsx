import Image from "next/image";
import TrainingPage from "../../training/page";
import styles from "./training-discovery.module.css";
export default function V2TrainingPage(){return <><section className={styles.hero} aria-label="Training together"><div><small>LEARN TOGETHER</small><h2>Small steps.<br/>A stronger bond.</h2><p>Start with what your dog needs. Compare programmes, then review your trainer and every session before reserving.</p><a href="#training-programmes">Explore training programmes ↓</a></div><Image src="/assets/pawspace-training-editorial.webp" alt="A person practising a reward-based exercise with three dogs at home" width={960} height={640} sizes="(max-width: 720px) 100vw, 45vw" priority/></section><div id="training-programmes"><TrainingPage routeScope="v2"/></div></>;}

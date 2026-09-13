"use client";
import React from "react";

type Props={name:string;children:React.ReactNode};
type State={failed:boolean};
export default class CriticalErrorBoundary extends React.Component<Props,State>{
 state:State={failed:false};
 static getDerivedStateFromError():State{return{failed:true};}
 componentDidCatch(error:Error){console.error(`PawSpace ${this.props.name} error`,error);}
 render(){if(this.state.failed)return <section role="alert" style={{padding:20,border:"1px solid #d8cfe1",borderRadius:16,display:"grid",gap:12}}><h2 style={{margin:0}}>Something went wrong.</h2><p style={{margin:0}}>We couldn’t continue this {this.props.name.toLowerCase()} safely. Your saved account data is unchanged.</p><button type="button" onClick={()=>{this.setState({failed:false});window.location.assign("/mobile-app");}}>Start Over</button></section>;return this.props.children;}
}

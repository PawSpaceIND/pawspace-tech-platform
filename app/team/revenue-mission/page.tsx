"use client";

import{useEffect,useState}from"react";

type WarningItem={severity:string;code:string;message:string};
type Contribution={employeeEmail:string;booked:number;collected:number;refunded:number;netCollected:number};
type ServiceMix={serviceCode:string;booked:number;collected:number;refunded:number;netCollected:number};
type
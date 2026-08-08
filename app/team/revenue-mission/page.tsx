"use client";

import{useEffect,useState}from"react";

type Warning={severity:string;code:string;message:string};
type Contribution={employeeEmail:string;booked:number;collected:number;refunded:number;netCollected:number};
type ServiceMix={serviceCode:string;booked:number;collected:number;refunded:number;netCollected:number};
type ProductivityFact={employeeEmail:string;leadsAssigned:number;meaningfulActions:number;qualifiedLeads:number;bookingConversions:number;netCollectedRevenue:number;firstResponseBreached:number};
type Command={
 status?:string;
 mission?:{name?:string;revenueBasis?:string;periodStart?:number;periodEnd?:number;config
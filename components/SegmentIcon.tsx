"use client";

import {
  Cloud,
  CircleDollarSign,
  Megaphone,
  Store,
  Sparkles,
  Building2,
  ShoppingCart,
  Factory,
  RadioTower,
  HeartPulse,
  Clapperboard,
  Truck,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  Cloud,
  CircleDollarSign,
  Megaphone,
  Store,
  Sparkles,
  Building2,
  ShoppingCart,
  Factory,
  RadioTower,
  HeartPulse,
  Clapperboard,
  Truck,
  ShieldCheck,
};

export function SegmentIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const Icon = ICONS[name] ?? Building2;
  return <Icon className={className} />;
}

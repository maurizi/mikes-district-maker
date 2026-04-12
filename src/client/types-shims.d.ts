// Type declarations for packages that don't ship their own types

declare module "react-aria-modal" {
  import { Component, ReactNode } from "react";

  interface AriaModalProps {
    titleText?: string;
    titleId?: string;
    onExit: () => void;
    initialFocus?: string;
    focusDialog?: boolean;
    underlayClickExits?: boolean;
    escapeExits?: boolean;
    underlayClass?: string;
    dialogClass?: string;
    dialogId?: string;
    underlayStyle?: React.CSSProperties;
    dialogStyle?: React.CSSProperties;
    children?: ReactNode;
    [key: string]: any;
  }

  export default class AriaModal extends Component<AriaModalProps> {}
}

declare module "polylabel" {
  export default function polylabel(
    polygon: number[][][],
    precision?: number
  ): [number, number] & { distance: number };
}

declare module "jwt-decode" {
  export default function jwtDecode<T = any>(token: string): T;
}

declare module "simplify-geojson" {
  import { GeoJSON } from "geojson";

  export default function simplify<G extends GeoJSON>(feature: G, tolerance?: number): G;
}

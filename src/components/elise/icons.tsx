import type { SVGProps } from "react";

/** Line icons drawn exactly as in the approved reference (1.5–1.8 stroke, round caps). */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, strokeWidth = 1.5, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

export const ChevronDownIcon = (p: IconProps) => (
  <Svg size={14} strokeWidth={1.6} {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);
export const ChevronRightIcon = (p: IconProps) => (
  <Svg size={14} strokeWidth={1.6} {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);
export const SettingsIcon = (p: IconProps) => (
  <Svg size={19} {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Svg>
);
export const MenuIcon = (p: IconProps) => (
  <Svg size={20} {...p}>
    <path d="M4 9h16M4 15h10" />
  </Svg>
);
export const CloseIcon = (p: IconProps) => (
  <Svg size={20} {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const ComposeIcon = (p: IconProps) => (
  <Svg size={19} {...p}>
    <path d="M12 20h8M16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1 1-4z" />
  </Svg>
);
export const SendIcon = (p: IconProps) => (
  <Svg strokeWidth={1.7} {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);
export const StopIcon = (p: IconProps) => (
  <Svg strokeWidth={1.7} {...p}>
    <rect x="7" y="7" width="10" height="10" rx="2" />
  </Svg>
);
export const CheckIcon = (p: IconProps) => (
  <Svg size={15} strokeWidth={1.8} {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);
export const PauseIcon = (p: IconProps) => (
  <Svg size={15} strokeWidth={1.8} {...p}>
    <path d="M9 6.5v11M15 6.5v11" />
  </Svg>
);
export const RunningIcon = (p: IconProps) => (
  <Svg size={15} strokeWidth={1.8} {...p}>
    <circle cx="12" cy="12" r="7.5" style={{ opacity: 0.25 }} />
    <path d="M12 4.5a7.5 7.5 0 0 1 7.5 7.5" />
  </Svg>
);
export const AlertIcon = (p: IconProps) => (
  <Svg size={15} strokeWidth={1.8} {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4.5M12 16h.01" />
  </Svg>
);
export const ExternalIcon = (p: IconProps) => (
  <Svg size={13} strokeWidth={1.7} {...p}>
    <path d="M8 16L16 8M9 8h7v7" />
  </Svg>
);

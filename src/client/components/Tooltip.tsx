import React, { useState, cloneElement, isValidElement } from "react";
import {
  useFloating,
  useHover,
  useFocus,
  useDismiss,
  useRole,
  useInteractions,
  offset,
  flip,
  shift,
  FloatingPortal,
  type Placement
} from "@floating-ui/react";

interface TooltipProps {
  readonly content: React.ReactNode;
  readonly children: React.ReactElement;
  readonly placement?: Placement;
  readonly visible?: boolean;
  readonly [key: string]: unknown;
}

const Tooltip = ({ content, children, placement = "top", visible }: TooltipProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const open = visible !== undefined ? visible : isOpen;

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setIsOpen,
    placement,
    middleware: [offset(8), flip(), shift({ padding: 5 })]
  });

  const hover = useHover(context, {
    delay: { open: 500, close: 0 },
    enabled: visible === undefined
  });
  const focus = useFocus(context, { enabled: visible === undefined });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "tooltip" });

  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);

  const child = isValidElement(children) ? children : <span>{children}</span>;

  return (
    <>
      {cloneElement(child, {
        ref: refs.setReference,
        ...getReferenceProps()
      })}
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{
              ...floatingStyles,
              backgroundColor: "#141414",
              color: "white",
              borderRadius: "2px",
              padding: "5px 9px",
              fontSize: "14px",
              lineHeight: 1.4,
              zIndex: 9999,
              pointerEvents: "none",
              maxWidth: 280
            }}
            {...getFloatingProps()}
          >
            {content}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

export default Tooltip;

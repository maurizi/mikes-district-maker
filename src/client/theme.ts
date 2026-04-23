// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { darken } from "@theme-ui/color";
import { type Theme } from "theme-ui";

export const heights = {
  header: "48px"
};

const appButtonStyles = {
  color: "white",
  display: "inline-flex",
  alignItems: "center",
  flexShrink: 0,
  justifyContent: "center",
  maxHeight: "100%",
  fontFamily: "heading",
  fontWeight: "medium",
  borderRadius: "3px",
  cursor: "pointer",
  "& > svg": {
    mr: 1
  },
  "&:hover:not([disabled]):not(:active)": {
    bg: "blue.6",
    color: "white",
    textDecoration: "none"
  },
  "&:active": {
    color: "white",
    bg: "blue.7"
  },
  "&:focus": {
    outline: "none",
    boxShadow: "focus"
  },
  "&[disabled]": {
    opacity: 0.5,
    cursor: "not-allowed"
  },
  "&:visited": {
    color: "white",
    fontWeight: "medium"
  }
};

const defaultConfirmationModalHeader = {
  padding: "16px 12px",
  margin: "-12px -12px 24px"
};

const theme: Theme = {
  breakpoints: ["40em", "52em", "64em"],
  fonts: {
    body: "-apple-system, BlinkMacSystemFont, avenir next, avenir, helvetica neue, helvetica, Ubuntu, roboto, noto, segoe ui, arial, sans-serif",
    heading:
      'frank-new, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
    monospace: "Menlo, monospace"
  },
  colors: {
    heading: "#141414",
    text: "#595959",
    background: "#eef0f2",
    primary: "#4B7AA0",
    secondary: "#6d6d6d",
    muted: "#fff",
    accent: "#ffc08e",
    warning: "#eec643",
    error: "#f06543",
    selectedRow: "#f2f6f9",
    selectedButtonBg: "#e5edf3",
    selectedButtonFg: "#131f28",
    link: "#4B7AA0",
    linkHover: "#395c78",
    success: [
      "#f7fde8",
      "#DCF8A5",
      "#BEEC75",
      "#9ED950",
      "#5AA516",
      "#438A0F",
      "#306F09",
      "#102c02"
    ],
    blue: [
      "#f2f6f9",
      "#e5edf3",
      "#bdd0e0",
      "#95b4cd",
      "#6d98ba",
      "#4B7AA0",
      "#395c78",
      "#2c485e",
      "#131f28"
    ],
    gray: [
      "#f8f9fa",
      "#eef0f2",
      "#d6d8da",
      "#8a8a8a",
      "#808080",
      "#6d6d6d",
      "#595959",
      "#2c2c2c",
      "#141414"
    ],
    modes: {
      dark: {
        heading: "#eaeaea",
        text: "#b8b8b8",
        background: "#15181c",
        primary: "#6d98ba",
        secondary: "#4a4e53",
        muted: "#23272d",
        selectedRow: "#2e3642",
        selectedButtonBg: "#2c485e",
        selectedButtonFg: "#e5edf3",
        link: "#95b4cd",
        linkHover: "#bdd0e0",
        accent: "#ffc08e",
        warning: "#eec643",
        error: "#f06543",
        success: [
          "#102c02",
          "#306F09",
          "#438A0F",
          "#5AA516",
          "#9ED950",
          "#BEEC75",
          "#DCF8A5",
          "#f7fde8"
        ],
        gray: [
          "#141414",
          "#1f2125",
          "#2e3136",
          "#4a4e53",
          "#707478",
          "#909498",
          "#afb3b7",
          "#cfd3d7",
          "#eaeaea"
        ]
      }
    }
  },
  config: {
    useColorSchemeMediaQuery: "system"
  },
  radii: {
    small: "2px",
    med: "4px"
  },
  shadows: {
    small: "0 0 4px rgba(0, 0, 0, .125)",
    large: "0 0 24px rgba(0, 0, 0, .30)",
    bright: "0 0 8px 2px rgba(109, 152, 186, 0.2)",
    focus: "0 0 0 2px rgba(109, 152, 186, 0.3)"
  },
  sizes: {
    form: "350px",
    small: "580px",
    medium: "750px",
    large: "1040px"
  },
  fontSizes: [12, 14, 16, 18, 21, 31, 37, 54],
  fontWeights: {
    light: 300,
    medium: 500,
    bold: 700,
    body: 500,
    heading: 500
  },
  lineHeights: {
    body: 1.65,
    heading: 1.125
  },
  text: {
    heading: {
      mb: 2,
      fontWeight: "heading",
      lineHeight: "heading",
      color: "heading"
    },
    caps: {
      textTransform: "uppercase"
    },
    h1: {
      variant: "text.heading",
      fontSize: 7,
      letterSpacing: 0
    },
    h2: {
      variant: "text.heading",
      fontSize: 6,
      letterSpacing: 0
    },
    h3: {
      variant: "text.heading",
      fontSize: 5,
      letterSpacing: 0
    },
    h4: {
      variant: "text.heading",
      fontSize: 4,
      fontWeight: "body",
      letterSpacing: 0
    },
    h5: {
      variant: "text.heading",
      fontSize: 3,
      fontWeight: "body",
      letterSpacing: 0
    },
    h6: {
      variant: "text.caps",
      fontSize: 2,
      fontWeight: "bold"
    }
  },
  cards: {
    flat: {
      borderRadius: "small",
      backgroundColor: "muted",
      my: 3,
      p: 24,
      boxShadow: "small"
    },
    disabled: {
      borderRadius: "small",
      backgroundColor: "muted",
      my: 4,
      p: 24,
      opacity: "0.4"
    },
    floating: {
      borderRadius: "small",
      boxShadow: "bright",
      backgroundColor: "muted",
      my: 4,
      p: 24
    }
  },
  space: [0, 4, 8, 12, 16, 24, 32, 48, 64, 128, 256],
  buttons: {
    primary: {
      ...appButtonStyles,
      bg: "primary"
    },
    secondary: {
      ...appButtonStyles,
      ...{
        bg: "secondary",
        "&:hover:not([disabled]):not(:active)": {
          bg: "gray.6"
        },
        "&:active": {
          bg: "gray.7"
        }
      }
    },
    success: {
      ...appButtonStyles,
      ...{
        bg: "success.4",
        "&:hover:not([disabled]):not(:active)": {
          bg: "success.5"
        },
        "&:active": {
          bg: "success.6"
        }
      }
    },
    danger: {
      ...appButtonStyles,
      ...{
        bg: "error",
        "&:hover:not([disabled]):not(:active)": {
          bg: darken("error", 0.2)
        },
        "&:active": {
          bg: darken("error", 0.3)
        }
      }
    },
    ghost: {
      ...appButtonStyles,
      ...{
        bg: "transparent",
        "&:hover:not([disabled]):not(:active)": {
          bg: "rgba(256,256,256,0.3)"
        },
        "&:active": {
          color: "blue.8",
          bg: "rgba(256,256,256,0.7)"
        }
      }
    },
    subtle: {
      ...appButtonStyles,
      ...{
        bg: "gray.1",
        color: "heading"
      },
      "&:hover:not([disabled]):not(:active)": {
        bg: "gray.2"
      },
      "&:active": {
        bg: "gray.3",
        color: "white"
      },
      "&[disabled]": {
        bg: "gray.1",
        color: "heading",
        opacity: 0.25,
        cursor: "not-allowed"
      }
    },
    minimal: {
      ...appButtonStyles,
      ...{
        bg: "transparent",
        color: "gray.8",
        "&:hover:not([disabled]):not(:active)": {
          textDecoration: "underline",
          bg: "rgba(256,256,256,0.2)"
        },
        "&[disabled]": {
          bg: "transparent",
          color: "gray.8",
          opacity: 0.25,
          cursor: "not-allowed"
        },
        "&:active": {
          bg: "rgba(256,256,256,0.3)"
        }
      }
    },
    linkStyle: {
      ...appButtonStyles,
      ...{
        bg: "transparent",
        color: "link",
        padding: 0,
        "&:hover:not([disabled]):not(:active)": {
          textDecoration: "underline",
          color: "linkHover",
          bg: "transparent"
        },
        "&[disabled]": {
          bg: "transparent",
          color: "gray.8",
          opacity: 0.25,
          cursor: "not-allowed"
        },
        "&:active": {
          bg: "rgba(256,256,256,0.3)",
          color: "blue.8"
        },
        "&:focus": {
          borderRadius: "small",
          boxShadow: "focus",
          outline: "none"
        }
      }
    },
    outlined: {
      display: "inline-flex",
      alignItems: "center",
      flexShrink: 0,
      justifyContent: "center",
      maxHeight: "100%",
      fontFamily: "heading",
      fontWeight: "medium",
      borderRadius: "3px",
      border: "1px solid",
      borderColor: "gray.2",
      bg: "muted",
      color: "gray.7",
      cursor: "pointer",
      "& > svg": {
        mr: 1
      },
      "&:hover:not([disabled]):not(:active)": {
        color: "gray.7",
        bg: "gray.1"
      },
      "&:active": {
        color: "gray.7",
        bg: "gray.2"
      },
      "&:focus": {
        outline: "none",
        boxShadow: "focus"
      },
      "&[disabled]": {
        cursor: "not-allowed",
        bg: "muted",
        opacity: 0.25
      }
    },
    quiet: {
      ...appButtonStyles,
      ...{
        backgroundColor: "muted",
        color: "text",
        "&:hover:not([disabled]):not(:active)": {
          bg: "blue.1"
        },
        "&:active": {
          bg: "blue.2"
        },
        "&:focus": {
          outline: "none",
          boxShadow: "focus"
        },
        "&.selected": {
          backgroundColor: "selectedButtonBg",
          color: "selectedButtonFg"
        }
      }
    },
    circular: {
      ...appButtonStyles,
      ...{
        borderRadius: "100px"
      }
    },
    circularSubtle: {
      ...appButtonStyles,
      ...{
        borderRadius: "100px",
        backgroundColor: "gray.1",
        color: "heading",
        "&:hover:not([disabled]):not(:active)": {
          bg: "gray.2"
        },
        "&:active": {
          bg: "gray.3"
        }
      }
    },
    icon: {
      ...appButtonStyles,
      ...{
        p: 1,
        bg: "transparent",
        color: "gray.8",
        borderRadius: "100%",
        "> svg": {
          mx: 0
        },
        "&:hover:not([disabled]):not(:active)": {
          bg: "rgba(89, 89, 89, 0.1)",
          color: "inherit"
        },
        "&[disabled]": {
          bg: "transparent",
          opacity: 0.25,
          cursor: "not-allowed"
        },
        "&:active": {
          bg: "rgba(89, 89, 89, 0.3)",
          color: "inherit"
        }
      }
    }
  },
  forms: {
    label: {
      mb: 1,
      fontSize: 1,
      fontWeight: "bold",
      color: "gray.5",
      textAlign: "left",
      variant: "text.caps"
    },
    radio: {
      "input:focus ~ &": {
        bg: "muted",
        boxShadow: "focus"
      }
    },
    checkbox: {
      "input:focus ~ &": {
        bg: "muted",
        boxShadow: "focus"
      }
    },
    input: {
      borderColor: "gray.2",
      "&:focus": {
        borderColor: "primary",
        boxShadow: "focus",
        outline: "none"
      }
    },
    select: {
      borderColor: "gray.2",
      backgroundColor: "muted",
      fontFamily: "heading",
      width: "auto",
      paddingRight: "30px",
      "&:focus": {
        borderColor: "primary",
        boxShadow: "focus",
        outline: "none"
      }
    },
    textarea: {
      borderColor: "gray.2",
      "&:focus": {
        borderColor: "primary",
        boxShadow: "focus",
        outline: "none"
      }
    }
  },
  links: {
    button: {
      ...appButtonStyles,
      backgroundColor: "primary",
      color: "white",
      textDecoration: "none",
      px: 3,
      py: 2
    },
    secondaryButton: {
      ...appButtonStyles,
      backgroundColor: "secondary",
      color: "white",
      textDecoration: "none",
      px: 3,
      py: 2,
      "&:visited,&:active": {
        bg: "secondary",
        color: "white"
      },
      "&:hover:not([disabled]):not(:active)": {
        bg: darken("secondary", 0.1),
        textDecoration: "none",
        color: "white"
      }
    },
    alert: {
      color: "gray.0",
      fontWeight: "bold",
      textDecoration: "underline",
      "&:visited": {
        color: "gray.0"
      },
      "&:active": {
        color: "gray.0"
      },
      "&:focus": {
        borderRadius: "small",
        outline: "none"
      }
    },
    linkButton: {
      ...appButtonStyles,
      backgroundColor: "primary",
      color: "white",
      textDecoration: "none",
      px: 3,
      py: 2
    }
  },
  styles: {
    hr: {
      color: "gray.2"
    },
    a: {
      color: "link",
      textDecoration: "none",
      "&:visited": {
        color: "link"
      },
      "&:hover:not([disabled]):not(:active)": {
        textDecoration: "underline"
      },
      "&:active": {
        color: "linkHover"
      },
      "&:focus": {
        borderRadius: "small",
        boxShadow: "focus",
        outline: "none"
      }
    },
    img: {
      maxWidth: "100%",
      height: "auto"
    },
    root: {
      m: 0,
      p: 0,
      fontFamily: "body",
      lineHeight: "body",
      fontWeight: "body",
      fontSize: 2
    },
    table: {
      borderCollapse: "collapse"
    },
    tr: {
      borderBottom: "1px solid",
      borderColor: "gray.2",
      "tbody > &:last-child": { borderBottom: "none" }
    },
    td: {
      py: 1
    },
    spinner: {
      small: {
        color: "primary",
        size: "24px",
        strokeWidth: "3px"
      },
      medium: {
        color: "primary",
        size: "48px",
        strokeWidth: "3px"
      },
      large: {
        color: "primary",
        strokeWidth: "3px",
        size: "60px"
      }
    },
    header: {
      app: {
        height: heights.header,
        flexShrink: 0,
        antiAlias: "",
        p: 2
      },
      title: {
        fontFamily: "heading",
        fontWeight: "light",
        fontSize: 2
      },
      left: {
        justifyContent: "flex-start",
        alignItems: "center",
        flex: 1,
        pl: 0
      },
      center: {
        justifyContent: "center",
        alignItems: "center",
        flex: 1
      },
      right: {
        justifyContent: "flex-end",
        alignItems: "center",
        flex: 1
      }
    },
    sidebar: {
      white: {
        bg: "muted",
        boxShadow:
          "0 0 0 1px rgba(16,22,26,.1), 0 0 0 rgba(16,22,26,0), 0 1px 1px rgba(16,22,26,.2)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        height: "100%",
        minWidth: "400px",
        position: "relative",
        color: "gray.8",
        zIndex: 200
      },
      expandedWhite: {
        bg: "muted",
        boxShadow:
          "0 0 0 1px rgba(16,22,26,.1), 0 0 0 rgba(16,22,26,0), 0 1px 1px rgba(16,22,26,.2)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        height: "100%",
        minWidth: "100%",
        position: "relative",
        color: "gray.8",
        zIndex: 200
      },
      gray: {
        bg: "gray.0",
        boxShadow:
          "0 0 0 1px rgba(16,22,26,.1), 0 0 0 rgba(16,22,26,0), 0 1px 1px rgba(16,22,26,.2)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        height: "100%",
        minWidth: "400px",
        position: "relative",
        color: "gray.8",
        zIndex: 200
      }
    },
    confirmationModal: {
      modal: {
        bg: "muted",
        p: 3,
        width: "small",
        maxWidth: "90vw"
      },
      errorHeader: {
        ...defaultConfirmationModalHeader,
        bg: "error"
      },
      warningHeader: {
        ...defaultConfirmationModalHeader,
        bg: "warning",
        color: "#141414"
      },
      footer: {
        flex: "auto",
        textAlign: "right",
        fontVariant: "tabular-nums",
        py: 2,
        mt: 2,
        fontSize: 1
      }
    }
  }
};

export default theme;

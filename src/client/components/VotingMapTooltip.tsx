import { mapValues, sum } from "lodash";
import { Box, ThemeUIStyleObject } from "theme-ui";

import { getPartyColor, capitalizeFirstLetter } from "../functions";

const style: Record<string, ThemeUIStyleObject> = {
  label: {
    textAlign: "left",
    py: 0,
    pr: 2,
    textTransform: "capitalize",
    width: "70px"
  },
  number: {
    flex: "auto",
    textAlign: "right",
    fontVariant: "tabular-nums",
    py: 0,
    fontWeight: "light"
  }
};

const Row = ({
  label,
  percent,
  color
}: {
  readonly label: string;
  readonly percent?: number;
  readonly color: string;
}) => (
  <tr
    sx={{
      color: "muted",
      border: "none"
    }}
  >
    <td sx={style.label}>{capitalizeFirstLetter(label)}</td>
    <td sx={{ minWidth: "50px", py: 0 }}>
      <Box
        style={{
          width: `${percent}%`
        }}
        sx={{
          height: "10px",
          backgroundColor: color,
          borderRadius: "1px"
        }}
      />
    </td>
    <td sx={style.number}>
      {percent ? percent.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "0"}
      {"%"}
    </td>
  </tr>
);

const VotingMapTooltip = ({ voting }: { readonly voting: { readonly [id: string]: number } }) => {
  const total = sum(Object.values(voting));
  const percentages = mapValues(voting, (votes: number) => (total ? votes / total : 0) * 100);
  const order = ["republican", "democrat"];
  // eslint-disable-next-line
  const rows = Object.entries(percentages)
    .sort(([a], [b]) => order.indexOf(b) - order.indexOf(a))
    .map(([party, percent]) => (
      <Row key={party} label={party} percent={percent} color={getPartyColor(party)} />
    ));

  return (
    <Box sx={{ width: "100%", minHeight: "100%" }}>
      <table sx={{ margin: "0", width: "100%" }}>
        <tbody>
          <Row label={"Dem."} percent={percentages["democrat"]} color={getPartyColor("democrat")} />
          <Row
            label={"Rep."}
            percent={percentages["republican"]}
            color={getPartyColor("republican")}
          />
          <Row
            label={"Other"}
            percent={percentages["other party"]}
            color={getPartyColor("other party")}
          />
        </tbody>
      </table>
    </Box>
  );
};

export default VotingMapTooltip;

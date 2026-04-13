import { Component } from "react";
import { Joyride, EventData, STATUS, Step } from "react-joyride";
import { IProject, IStaticMetadata, IUser } from "../../shared/entities";
import { patchUser } from "../api";
import { geoLevelLabel, getPopulationPerRepresentative } from "../functions";
import SalamanderIllustration from "../media/tour-salamander-builder.svg?react";
import tourClickingGif from "../media/tour-clicking-counties-sidebar.gif";
import tourCountiesGif from "../media/tour-counties-blockgroups.gif";
import { DistrictsGeoJSON } from "../types";

interface Props {
  readonly geojson: DistrictsGeoJSON;
  readonly project: IProject;
  readonly staticMetadata: IStaticMetadata;
  readonly user: IUser;
}

interface State {
  readonly run: boolean;
  readonly steps: Step[];
}

class Tour extends Component<Props, State> {
  constructor(props: Props) {
    super(props);

    const numberOfDistricts = props.project.numberOfDistricts;
    const population = Math.round(
      getPopulationPerRepresentative(props.geojson, props.project.numberOfMembers)
    ).toLocaleString();
    const regionConfig = props.project.regionConfig.name;
    const geoLevelsSingular = props.staticMetadata.geoLevelHierarchy
      .map(geolevel => geolevel.id)
      .reverse();
    const largestGeoLevelSingular = geoLevelsSingular[0];
    const geoLevelsPlural = geoLevelsSingular.map(label => geoLevelLabel(label).toLowerCase());
    const largestGeoLevelPlural = geoLevelsPlural[0];
    const availableGeolevelsText =
      geoLevelsPlural.length > 2
        ? `${geoLevelsPlural.slice(0, -1).join(", ")}, and ${
            geoLevelsPlural[geoLevelsPlural.length - 1]
          }`
        : geoLevelsPlural.length == 2
          ? `${largestGeoLevelPlural} and ${geoLevelsPlural[1]}`
          : largestGeoLevelPlural;

    this.state = {
      run: !props.user.hasSeenTour,
      steps: [
        {
          title: "Welcome to DistrictBuilder!",
          content: (
            <div>
              <SalamanderIllustration width="135px" />
              <p>
                Do you want help building
                <br />
                your first map?
              </p>
            </div>
          ),
          locale: {
            skip: <strong aria-label="skip">No, thanks</strong>,
            next: <span aria-label="next">Yes, please</span>
          },
          showProgress: false,
          placement: "top-start",
          hideOverlay: true,
          skipBeacon: true,
          target: "#tour-start",
          width: 300,
          styles: {
            tooltipContainer: {
              textAlign: "center"
            }
          }
        },
        {
          content: (
            <p>
              Great! I’ll walk you through some redistricting basics and show you how to get started
              with DistrictBuilder.
            </p>
          ),
          placement: "center",
          target: "body",
          width: 350,
          styles: {
            tooltipContainer: {
              textAlign: "center"
            }
          }
        },
        {
          content: (
            <p>
              Your objective: build <strong>{numberOfDistricts} districts</strong> for{" "}
              <strong>{regionConfig}, </strong>
              each with a population of <strong>{population}</strong> per representative. Use
              DistrictBuilder to group {availableGeolevelsText} into districts.
            </p>
          ),
          skipBeacon: true,
          placement: "center",
          target: "body",
          width: 500,
          styles: {
            tooltipContainer: {
              textAlign: "center"
            }
          }
        },
        {
          content:
            "The sidebar lists all your districts and their stats. Each district is represented by a unique color and number.",
          placement: "right-start",
          skipBeacon: true,
          target: ".map-sidebar",
          width: 350
        },
        {
          content: (
            <div>
              <p>
                Each district has a target population – the number of people who need to live there
                to maintain equal population districts.
              </p>
              <p>
                The <strong>deviation</strong> column tells you how far off a district is from that
                target. A negative deviation means you need to add more people to that district, and
                a positive deviation means you need to remove people from that district. Try to{" "}
                <strong>minimize deviation for each district</strong> while maintaining fair,
                representative districts.
              </p>
            </div>
          ),
          placement: "auto",
          skipBeacon: true,
          target: ".deviation-header",
          width: 400
        },
        {
          content: (
            <p>
              The ∅ row is special. It is not a regular district, but represents the population of
              any areas <strong>not yet assigned to a district.</strong> As you create your
              districts, this number gets smaller.
            </p>
          ),
          placement: "right",
          skipBeacon: true,
          target: ".unassigned-row",
          width: 450
        },
        {
          content: (
            <div>
              <div
                sx={{
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderRadius: "2px",
                  borderColor: "gray.2",
                  lineHeight: "0"
                }}
              >
                <img
                  src={tourClickingGif}
                  width="100%"
                  height="auto"
                  alt="User clicks on two geounits in the application and the sidebar updates."
                />
              </div>
              <p>
                We’re ready to start building! By default, District 1 is selected in the sidebar. As
                you add {largestGeoLevelPlural}, you can see the population of District 1 increase.
              </p>
              <div sx={{ bg: "success.1", color: "success.8", borderRadius: "2", p: 3 }}>
                <strong>Try it now:</strong> click on a {largestGeoLevelSingular} on the map to add
                it to District 1.
              </div>
            </div>
          ),
          placement: "left",
          skipBeacon: true,
          isFixed: true,
          target: ".maplibregl-map",
          width: 350
        },
        {
          content: (
            <div>
              <p>
                When you are happy with District 1, click “Accept” to save your changes. The{" "}
                {largestGeoLevelPlural} you selected will turn green, matching the color of District
                1, meaning they have been saved to District 1.
              </p>
            </div>
          ),
          placement: "right-start",
          skipBeacon: true,
          target: ".sidebar-header",
          width: 400
        },
        {
          content: (
            <div>
              <div
                sx={{
                  maxWidth: "250px",
                  mx: "auto",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderRadius: "2px",
                  borderColor: "gray.2",
                  lineHeight: "0"
                }}
              >
                <img
                  src={tourCountiesGif}
                  width="100%"
                  height="auto"
                  alt="User toggles geolevel selection"
                />
              </div>
              {geoLevelsPlural.length === 1 ? (
                <p>
                  The only census boundary available for this map is {largestGeoLevelPlural}. Try to
                  evenly distribute the population between all districts the best you can.
                </p>
              ) : (
                <p>
                  We recommend starting your map with {largestGeoLevelPlural} because they are the
                  largest census boundary available for this map. Try to evenly distribute the
                  population between all districts the best you can.
                </p>
              )}
              {geoLevelsPlural.length === 1 ? null : (
                <p>
                  Working with {largestGeoLevelPlural} is like using a large paint roller – great
                  for covering a lot of ground quickly, but eventually you need a more detailed tool
                  around the edges. Switch to {geoLevelsPlural[1]} to make finer level changes to
                  your map and get even closer to zero deviation.
                </p>
              )}
            </div>
          ),
          placement: "auto",
          skipBeacon: true,
          target: ".geolevel-button-group",
          width: 500
        },
        {
          content: (
            <p>
              You can find additional tutorials and contact us in the <strong>Resources</strong>{" "}
              menu. Thank you for using DistrictBuilder and fighting for fair and transparent
              redistricting!
            </p>
          ),
          placement: "auto",
          skipBeacon: true,
          target: ".support-menu",
          width: 400
        }
      ]
    };
  }

  private handleJoyrideCallback(data: EventData) {
    const { status } = data;
    const finishedStatuses: readonly string[] = [STATUS.FINISHED, STATUS.SKIPPED];

    if (finishedStatuses.includes(status)) {
      this.setState({ run: false });
      void patchUser({ hasSeenTour: true });
    }
  }

  public render() {
    const { run, steps } = this.state;

    return (
      // TODO: [react-joyride v3] 'spotlightClicks' was removed (v3 default: blockTargetInteraction is false).
      // TODO: [react-joyride v3] 'disableScrollParentFix' was removed with no replacement.
      <Joyride
        onEvent={data => this.handleJoyrideCallback(data)}
        continuous={true}
        run={run}
        scrollToFirstStep={false}
        locale={{
          skip: <strong aria-label="skip">Skip tour</strong>
        }}
        steps={steps}
        styles={{
          beacon: {
            display: "none"
          },

          tooltip: {
            borderRadius: "3px"
          },

          tooltipContainer: {
            textAlign: "left"
          },

          tooltipTitle: {
            fontSize: 21,
            color: "#141414",
            fontWeight: "normal",
            fontFamily:
              'frank-new, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
          },

          buttonClose: {
            display: "none"
          },

          buttonPrimary: {
            borderRadius: "3px",
            fontFamily:
              'frank-new, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
          },

          buttonBack: {
            fontSize: 14,
            color: "#395c78",
            fontWeight: "bold"
          },

          buttonSkip: {
            fontSize: 14,
            color: "#395c78",
            fontWeight: "bold"
          },

          tooltipContent: {
            padding: "20px 10px 5px"
          }
        }}
        options={{
          showProgress: true,
          overlayClickAction: false,
          skipScroll: true,
          spotlightPadding: 10,
          arrowColor: "#fff",
          backgroundColor: "#fff",
          overlayColor: "rgba(20, 20, 20, 0.4)",
          primaryColor: "#6d98ba",
          textColor: "#595959",
          width: 500,
          zIndex: 1000,
          buttons: ["back", "close", "primary", "skip"]
        }}
      />
    );
  }
}

export default Tour;

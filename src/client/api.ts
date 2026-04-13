import axios, { AxiosResponse } from "axios";
import { saveAs } from "file-saver";
import memoize from "memoizee";

import {
  CreateProjectData,
  IOrganization,
  IProject,
  IProjectTemplateWithProjects,
  IRegionConfig,
  IUser,
  JWT,
  OrganizationSlug,
  ProjectId,
  ProjectTemplateId,
  UpdateProjectData,
  UpdateUserData,
  UserId,
  RegionConfigId,
  ProjectNest,
  DistrictsImportApiResponse,
  IReferenceLayer,
  ReferenceLayerId,
  CreateReferenceLayerData,
  IProjectTemplate,
  CreateProjectTemplateData,
  IStaticMetadata,
  UpdateReferenceLayer
} from "../shared/entities";
import { PLANSCORE_POLL_MS, PLANSCORE_POLL_MAX_TRIES } from "../shared/constants";
import {
  DistrictsGeoJSON,
  DynamicProjectData,
  PaginatedResponse,
  ReferenceLayerWithGeojson
} from "./types";
import { getJWT, setJWT } from "./jwt";
import { fetchStaticMetadata } from "./s3";

const apiAxios = axios.create();

function setAxiosAuthHeaders(jwt: JWT): void {
  // Disabling 'functional/immutable-data' without naming it.
  // See https://github.com/jonaskello/eslint-plugin-functional/issues/105

  apiAxios.defaults.headers.common.Authorization = `Bearer ${jwt}`;
}

const authToken = getJWT();
// Disabling 'functional/no-conditional-statement' without naming it.
// See https://github.com/jonaskello/eslint-plugin-functional/issues/105

if (authToken) {
  setAxiosAuthHeaders(authToken);
}

function saveJWT(response: AxiosResponse<JWT>): JWT {
  const jwt = response.data;
  setJWT(jwt);
  setAxiosAuthHeaders(jwt);
  return jwt;
}

function formatProject(project: IProject): IProject {
  return {
    ...project,
    createdDt: new Date(project.createdDt),
    updatedDt: new Date(project.updatedDt),
    submittedDt: project.submittedDt ? new Date(project.submittedDt) : undefined
  };
}

export async function authenticateUser(email: string, password: string): Promise<JWT> {
  return new Promise((resolve, reject) => {
    apiAxios
      .post("/api/auth/email/login", { email, password })
      .then(response => resolve(saveJWT(response)))
      .catch(error => reject(error.response?.data || error));
  });
}

export async function fetchUser(): Promise<IUser> {
  return new Promise((resolve, reject) => {
    apiAxios
      .get("/api/user")
      .then(response => resolve(response.data))
      .catch(error => reject(error.message));
  });
}

export async function patchUser(userData: Partial<UpdateUserData>): Promise<IUser> {
  return new Promise((resolve, reject) => {
    apiAxios
      .patch(`/api/user/`, userData)
      .then(response => resolve(response.data))
      .catch(() => reject());
  });
}

export async function registerUser(
  name: string,
  email: string,
  password: string,
  isMarketingEmailOn: boolean,
  organization?: string
): Promise<JWT> {
  const data = organization
    ? { name, email, password, organization, isMarketingEmailOn }
    : { name, email, password, isMarketingEmailOn };
  return new Promise((resolve, reject) => {
    apiAxios
      .post("/api/auth/email/register", data)
      .then(response => resolve(saveJWT(response)))
      .catch(error => reject(error.response?.data || error));
  });
}

export async function initiateForgotPassword(email: string): Promise<void> {
  return new Promise((resolve, reject) => {
    apiAxios
      .post(`/api/auth/email/forgot-password/${email}`)
      .then(() => resolve())
      .catch(error => reject(error.response?.data || error));
  });
}

export async function resendConfirmationEmail(email: string): Promise<void> {
  return new Promise((resolve, reject) => {
    apiAxios
      .post(`/api/auth/email/resend-verification/${email}`)
      .then(() => resolve())
      .catch(error => reject(error.response?.data || error));
  });
}

export async function activateAccount(token: string): Promise<JWT> {
  return new Promise((resolve, reject) => {
    apiAxios
      .post(`/api/auth/email/verify/${token}`)
      .then(response => resolve(response.data))
      .catch(error => reject(error.message));
  });
}

export async function resetPassword(token: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    apiAxios
      .post(`/api/auth/email/reset-password/${token}`, { password })
      .then(() => resolve())
      .catch(error => reject(error.response?.data || error));
  });
}

export async function createProject(data: CreateProjectData): Promise<IProject> {
  return new Promise((resolve, reject) => {
    apiAxios
      .post("/api/projects", data)
      .then(response => resolve(formatProject(response.data)))
      .catch(error => reject(error.response?.data || error));
  });
}

export async function copyProject(id: ProjectId): Promise<IProject> {
  return new Promise((resolve, reject) => {
    apiAxios
      .post(`/api/projects/${id}/duplicate`)
      .then(response => resolve(formatProject(response.data)))
      .catch(error => reject(error.response?.data || error));
  });
}

async function fetchProject(id: ProjectId): Promise<IProject> {
  return new Promise((resolve, reject) => {
    apiAxios
      .get(`/api/projects/${id}`)
      .then(response => resolve(formatProject(response.data)))
      .catch(error =>
        reject({ errorMessage: error.response.data, statusCode: error.response.status })
      );
  });
}

export async function fetchProjectReferenceLayers(
  id: ProjectId
): Promise<readonly IReferenceLayer[]> {
  return new Promise((resolve, reject) => {
    apiAxios
      .get(`/api/reference-layer/project/${id}`)
      .then(response => resolve(response.data))
      .catch(error => reject(error.response.data));
  });
}

export async function fetchProjects(
  page: number,
  limit: number
): Promise<PaginatedResponse<IProject>> {
  return new Promise((resolve, reject) => {
    apiAxios
      .get(`/api/projects?page=${page}&limit=${limit}&sort=updatedDt,DESC`)
      .then(response => resolve(response.data))
      .catch(error => reject(error.response.data));
  });
}

export async function fetchAllPublishedProjects(
  page: number,
  limit: number,
  region?: string
): Promise<PaginatedResponse<IProject>> {
  const endpoint = region
    ? `/api/globalProjects?page=${page}&limit=${limit}&completed=true&region=${region}`
    : `/api/globalProjects?page=${page}&limit=${limit}&completed=true`;
  return new Promise((resolve, reject) => {
    apiAxios
      .get(endpoint)
      .then(response => {
        return resolve(response.data);
      })
      .catch(error => reject(error.response.data));
  });
}

export async function fetchProjectData(id: ProjectId): Promise<DynamicProjectData> {
  // GeoJSON is now computed client-side after static data loads.
  // Provide empty placeholder here; localMergeComplete will fill it.
  const project = await fetchProject(id);
  return {
    project,
    geojson: { type: "FeatureCollection", features: [] }
  };
}

export async function fetchRegionConfigs(): Promise<readonly IRegionConfig[]> {
  return new Promise((resolve, reject) => {
    apiAxios
      .get("/api/region-configs?sort=name,ASC")
      .then(response => {
        resolve(response.data);
      })
      .catch(error => reject(error.message));
  });
}

export async function patchProject(
  id: ProjectId,
  projectData: Partial<UpdateProjectData>
): Promise<IProject> {
  return new Promise((resolve, reject) => {
    apiAxios
      .patch(`/api/projects/${id}`, projectData)
      .then(response => resolve(formatProject(response.data)))
      .catch(error => reject(error.response?.data || error));
  });
}

export async function convertGeoJsonToShapefile(
  geojson: DistrictsGeoJSON,
  projectName: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    apiAxios
      .post("/api/projects/convert/shp", geojson, { responseType: "blob" })
      .then(response => {
        return resolve(
          saveAs(new Blob([response.data], { type: "application/zip" }), `${projectName}.zip`)
        );
      })
      .catch(error => reject(error.message));
  });
}

export async function importCsv(
  file: Blob,
  regionConfigId?: RegionConfigId
): Promise<DistrictsImportApiResponse> {
  const formData = new FormData();
  formData.append("file", file);
  return new Promise((resolve, reject) => {
    apiAxios
      .post(
        `/api/districts/import/csv${regionConfigId ? `?regionConfigId=${regionConfigId}` : ""}`,
        formData,
        {
          headers: { "Content-Type": "multipart/form-data" }
        }
      )
      .then(response => {
        return resolve(response.data);
      })
      .catch(error => reject(error.message));
  });
}

export async function createReferenceLayer(
  referenceLayer: CreateReferenceLayerData
): Promise<ReferenceLayerWithGeojson> {
  return new Promise((resolve, reject) => {
    apiAxios
      .post(`/api/reference-layer/`, referenceLayer)
      .then(response => {
        return resolve(response.data);
      })
      .catch(error => reject(error.message));
  });
}

export async function deleteReferenceLayer(
  referenceLayerId: ReferenceLayerId
): Promise<ReferenceLayerId> {
  return new Promise((resolve, reject) => {
    apiAxios
      .delete(`/api/reference-layer/${referenceLayerId}`)
      .then(() => resolve(referenceLayerId))
      .catch(error => reject(error.message));
  });
}

export async function patchReferenceLayer(
  referenceLayerId: ReferenceLayerId,
  color: Partial<UpdateReferenceLayer>
): Promise<ReferenceLayerWithGeojson> {
  return new Promise((resolve, reject) => {
    apiAxios
      .patch(`/api/reference-layer/${referenceLayerId}`, color)
      .then(response => resolve(response.data))
      .catch(error => reject(error.message));
  });
}

export async function fetchOrganization(slug: OrganizationSlug): Promise<IOrganization> {
  return new Promise((resolve, reject) => {
    apiAxios
      .get(`/api/organization/${slug}`)
      .then(response => resolve(response.data))
      .catch(error => {
        reject({ errorMessage: error.response.data, statusCode: error.response.status });
      });
  });
}

export async function fetchOrganizationProjects(
  slug: OrganizationSlug
): Promise<readonly IProjectTemplateWithProjects[]> {
  return new Promise((resolve, reject) => {
    apiAxios
      .get(`/api/project_templates/${slug}`)
      .then(response => {
        resolve(response.data);
      })
      .catch(error => {
        reject(error.response.data);
      });
  });
}

export async function createProjectTemplate(
  slug: OrganizationSlug,
  data: CreateProjectTemplateData
): Promise<IProjectTemplate> {
  return new Promise((resolve, reject) => {
    apiAxios
      .post(`/api/project_templates/${slug}`, data)
      .then(response => resolve(response.data))
      .catch(error => reject(error.response?.data || error));
  });
}

export async function archiveProjectTemplate(
  slug: OrganizationSlug,
  id: ProjectTemplateId
): Promise<ProjectTemplateId> {
  return new Promise((resolve, reject) => {
    apiAxios
      .put(`/api/project_templates/${slug}/${id}`)
      .then(response => resolve(response.data))
      .catch(error => reject(error.message));
  });
}

export async function fetchOrganizationFeaturedProjects(
  slug: OrganizationSlug
): Promise<readonly IProjectTemplateWithProjects[]> {
  return new Promise((resolve, reject) => {
    apiAxios
      .get(`/api/project_templates/featured/${slug}`)
      .then(response => {
        resolve(response.data);
      })
      .catch(error => {
        reject(error.response.data);
      });
  });
}

export const fetchMemoizedStateBbox = memoize(
  async (region: IRegionConfig): Promise<IStaticMetadata["bbox"]> => {
    const staticMetadata = await fetchStaticMetadata(region.s3URI);
    return staticMetadata.bbox;
  },
  {
    normalizer: (args: [region: IRegionConfig]) => JSON.stringify(args[0].id)
  }
);

export async function exportOrganizationProjectsCsv(slug: OrganizationSlug): Promise<void> {
  return new Promise((resolve, reject) => {
    apiAxios
      .get(`/api/project_templates/${slug}/export/maps-csv/`)
      .then(response => {
        const today = new Date();
        const dateString = today.toISOString().split("T")[0];
        return resolve(
          saveAs(
            new Blob([response.data], { type: "text/csv;charset=utf-8" }),
            `${dateString}-${slug}-maps.csv`
          )
        );
      })
      .catch(error => reject(error.message));
  });
}

export async function exportOrganizationUsersCsv(slug: OrganizationSlug): Promise<void> {
  return new Promise((resolve, reject) => {
    apiAxios
      .get(`/api/organization/${slug}/export/users-csv/`)
      .then(response => {
        const today = new Date();
        const dateString = today.toISOString().split("T")[0];
        return resolve(
          saveAs(
            new Blob([response.data], { type: "text/csv;charset=utf-8" }),
            `${dateString}-${slug}-users.csv`
          )
        );
      })
      .catch(error => reject(error.message));
  });
}

export async function saveProjectFeatured(project: ProjectNest): Promise<IOrganization> {
  return new Promise((resolve, reject) => {
    const projectPost = {
      isFeatured: !project.isFeatured
    };
    apiAxios
      .post(`/api/projects/${project.id}/toggleFeatured`, projectPost)
      .then(response => resolve(response.data))
      .catch(error => {
        reject(error.message);
      });
  });
}

export async function submitProject(projectId: ProjectId): Promise<IProject> {
  return new Promise((resolve, reject) => {
    apiAxios
      .post(`/api/projects/${projectId}/submit`)
      .then(response => resolve(formatProject(response.data)))
      .catch(error => {
        reject(error.message);
      });
  });
}

async function pollForPlanScoreUpdates(projectId: ProjectId, numTries = 1): Promise<IProject> {
  return new Promise((resolve, reject) => {
    fetchProject(projectId)
      .then(project =>
        // Return an error for either an explicit error from the backend or a timeout
        project.planscoreUrl === "error" || numTries > PLANSCORE_POLL_MAX_TRIES
          ? reject()
          : project.planscoreUrl === ""
            ? setTimeout(
                () => resolve(pollForPlanScoreUpdates(projectId, numTries + 1)),
                PLANSCORE_POLL_MS
              )
            : resolve(project)
      )
      .catch(() => reject());
  });
}

// PlanScore multi-step upload, driven from the browser.
//
// Steps 1 and 3 require a bearer token we can't ship to the client, so we
// proxy them through our server. Step 2 (the geometry PUT) goes directly to
// PlanScore's S3 bucket — the large payload never touches our server.
// See https://github.com/PlanScore/PlanScore/blob/main/API.md
export async function checkPlanScoreAPI(
  project: IProject,
  geojson: DistrictsGeoJSON
): Promise<IProject> {
  // Step 1: ask the server to fetch a signed-upload policy from PlanScore.
  const credsResponse = await apiAxios.get<[string, Record<string, string>]>(
    `/api/projects/${project.id}/plan-score/upload-credentials`
  );
  const [s3Uri, uploadFields] = credsResponse.data;

  // Step 2: POST the geometry directly to PlanScore's S3 bucket. The
  // success_action_redirect field tells S3 where to 302 to, and that's also
  // the callback URL we'll hand back to the server for step 3. Use
  // redirect: "manual" so we don't chase the redirect (which would be a GET
  // without a bearer token and fail).
  //
  // The unassigned district must be stripped; PlanScore treats its presence
  // as an incomplete plan and never finishes processing.
  const callbackLocation = uploadFields.success_action_redirect;
  if (!callbackLocation) {
    throw new Error("PlanScore upload response missing success_action_redirect");
  }
  const form = new FormData();
  Object.entries(uploadFields).forEach(([key, val]) => form.append(key, val));
  const strippedGeojson = { ...geojson, features: geojson.features.slice(1) };
  form.append(
    "file",
    new Blob([JSON.stringify(strippedGeojson)], { type: "application/json" }),
    `${project.name}.geojson`
  );
  await fetch(s3Uri, { method: "POST", body: form, redirect: "manual" });

  // Step 3: ask the server to post the callback to PlanScore. The server
  // fire-and-forgets polling and writes planscoreUrl onto the project row
  // when PlanScore finishes, which the poll below picks up.
  await apiAxios.post(`/api/projects/${project.id}/plan-score/finalize`, {
    callbackLocation,
    description: project.name
  });

  return pollForPlanScoreUpdates(project.id);
}

export async function addUserToOrganization(
  slug: OrganizationSlug,
  user: UserId
): Promise<IOrganization> {
  const userAdd = { userId: user };
  return new Promise((resolve, reject) => {
    apiAxios
      .post(`/api/organization/${slug}/join`, userAdd)
      .then(response => resolve(response.data))
      .catch(error => {
        reject(error.message);
      });
  });
}

export async function removeUserFromOrganization(
  slug: OrganizationSlug,
  user: UserId
): Promise<IOrganization> {
  const userRemove = { userId: user };
  return new Promise((resolve, reject) => {
    apiAxios
      .post(`/api/organization/${slug}/leave`, userRemove)
      .then(response => resolve(response.data))
      .catch(error => {
        reject(error.message);
      });
  });
}

// Retrieves total population for the region from static metadata
export async function fetchTotalPopulation(region: IRegionConfig) {
  const staticMetadata = await fetchStaticMetadata(region.s3URI);
  return staticMetadata.totalPopulation;
}

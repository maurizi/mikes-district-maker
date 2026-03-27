/* eslint-disable @typescript-eslint/unbound-method */
import { DataType, IBackup, newDb } from "pg-mem";
import { v4 } from "uuid";
import * as typeorm from "typeorm";

import CreateRandomProjects from "../commands/create-random-projects";
import { RegionConfig } from "../../../server/src/region-configs/entities/region-config.entity";
import { Project } from "../../../server/src/projects/entities/project.entity";
import { User } from "../../../server/src/users/entities/user.entity";
import { dataSourceOptions, createDataSource } from "../lib/dbUtils";

jest.mock("../lib/dbUtils", () => {
  const original = jest.requireActual("../lib/dbUtils");
  return {
    ...original,
    createDataSource: jest.fn()
  };
});

// Mock S3 to return a simple hierarchy
const mockHierarchy = JSON.stringify([0, 1, 2]);
jest.mock("../../../server/src/common/functions", () => {
  const original = jest.requireActual("../../../server/src/common/functions");
  return {
    ...original,
    getObject: jest.fn().mockResolvedValue({
      Body: {
        transformToString: () => Promise.resolve(mockHierarchy)
      }
    })
  };
});

jest.useFakeTimers({ advanceTimers: true });

describe("Create random projects", () => {
  let regionConfigRepo: typeorm.Repository<RegionConfig>;
  let projectRepo: typeorm.Repository<Project>;
  let userRepo: typeorm.Repository<User>;
  let user: User;
  let testDb;
  let connection: typeorm.Connection;
  let dbBackup: IBackup;

  beforeAll(async () => {
    testDb = newDb({
      autoCreateForeignKeyIndices: true
    });

    testDb.public.registerFunction({
      name: "current_database",
      returns: DataType.text,
      implementation: () => "districtbuilder"
    });
    testDb.registerExtension("uuid-ossp", schema => {
      schema.registerFunction({
        name: "uuid_generate_v4",
        returns: DataType.uuid,
        implementation: v4,
        impure: true
      });
    });

    const mockedCreateDataSource = createDataSource as jest.MockedFunction<typeof createDataSource>;
    connection = await testDb.adapters.createTypeormConnection({
      type: dataSourceOptions.type,
      entities: dataSourceOptions.entities
    });

    mockedCreateDataSource.mockImplementation(() => Promise.resolve(connection));
    await connection.synchronize();
    dbBackup = testDb.backup();
  });

  function addRegion(s3URI: string) {
    return regionConfigRepo.save({
      id: v4(),
      s3URI,
      name: s3URI.substring(53, 55),
      regionCode: s3URI.substring(53, 55),
      countryCode: "US",
      archived: false,
      version: new Date("2020-09-09T19:50:10.921Z")
    });
  }

  beforeEach(async () => {
    user = new User();
    user.email = "test@example.com";
    user.name = "Mike";
    await user.setPassword("password");
    regionConfigRepo = connection.getRepository(RegionConfig);
    projectRepo = connection.getRepository(Project);
    userRepo = connection.getRepository(User);
    // @ts-ignore
    await userRepo.save(user);
  });

  afterEach(() => {
    jest.clearAllTimers();
    dbBackup.restore();
  });

  it("should create a project", async () => {
    expect.assertions(2);
    await addRegion(
      "s3://global-districtbuilder-dev-us-east-1/regions/US/DE/2020-09-09T19:50:10.921Z/"
    );
    try {
      await CreateRandomProjects.run(["1"]);
    } catch (err: any) {
      expect(err.oclif.exit).toBe(0);
      expect(await projectRepo.count()).toBe(1);
    }
  });

  it("should create no project if there are no regions", async () => {
    expect.assertions(2);
    try {
      await CreateRandomProjects.run(["1"]);
    } catch (err: any) {
      expect(err.oclif.exit).toBe(1);
      expect(await projectRepo.count()).toBe(0);
    }
  });
});

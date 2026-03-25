import { join } from "path";
import { DataSource, DataSourceOptions } from "typeorm";

export const dataSourceOptions: DataSourceOptions = {
  type: "postgres",
  host: process.env.POSTGRES_HOST,
  port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
  username: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  logging: process.env.NODE_ENV === "Development",
  synchronize: false,
  entities: [join(__dirname, "**/*.entity.{js,ts}")],
  migrations: [join(__dirname, "../migrations/*.{js,ts}")]
};

// Used by TypeORM CLI for migrations
export default new DataSource(dataSourceOptions);

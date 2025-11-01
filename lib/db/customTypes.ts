import { customType } from "drizzle-orm/pg-core";

type VectorConfig = {
  dimensions: number;
};

export const vector = (columnName: string, config: VectorConfig) =>
  customType<{ data: number[]; driverData: string | number[] }>({
    dataType() {
      return `vector(${config.dimensions})`;
    },
    toDriver(value) {
      if (Array.isArray(value)) {
        return `[${value.join(",")}]`;
      }
      return value;
    },
    fromDriver(value) {
      if (typeof value === "string") {
        return value
          .replace(/^\[/, "")
          .replace(/\]$/, "")
          .split(",")
          .filter(Boolean)
          .map((component) => Number(component.trim()));
      }
      if (Array.isArray(value)) {
        return value.map(Number);
      }
      throw new TypeError("Unsupported vector value returned by driver");
    },
  })(columnName);

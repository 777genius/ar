import {
  hostedAggregateIoDropIn,
  hostedIoLimitPaths,
} from "./hosted-app-server-resource-policy";

process.stdout.write(hostedAggregateIoDropIn(hostedIoLimitPaths()));

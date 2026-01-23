import appConfig from 'appConfig';
const _ = require('lodash');

const scenarios = {
  1: {
    routeType: '3',
    hillReluctance: '1',
  },
  2: {
    routeType: '3',
    hillReluctance: '2',
  },
  3: {
    routeType: '3',
    hillReluctance: '3',
  },
  4: {
    routeType: '2',
    hillReluctance: '1',
  },
  5: {
    routeType: '2',
    hillReluctance: '2',
  },
  6: {
    routeType: '2',
    hillReluctance: '3',
  },
  7: {
    routeType: '1',
    hillReluctance: '1',
  },
  8: {
    routeType: '1',
    hillReluctance: '2',
  },
  9: {
    routeType: '1',
    hillReluctance: '3',
  },
};

// When HILL_ROUTING_ENABLED is false, scenario is routeType
export function scenarioToComponents(scenario) {
  if (appConfig.HILL_ROUTING_ENABLED === false) {
    return {
      routeType: scenario,
      hillReluctance: null,
    };
  }

  return scenarios[scenario];
}

// When HILL_ROUTING_ENABLED is false, scenario is routeType
export function componentsToScenario(components) {
  if (appConfig.HILL_ROUTING_ENABLED === false) {
    return components.routeType;
  }

  return _.findKey(scenarios, (scenario) => _.isMatch(scenario, components));
}

import { useWindowDimensions } from 'react-native';
import { laneColumns } from './boardLanes';

/** [STORE-BOARD A2/A3] How many board lanes fit side by side on this screen, now (follows a resize or a split view). */
export function useBoardColumns(): 1 | 2 | 4 {
  return laneColumns(useWindowDimensions().width);
}

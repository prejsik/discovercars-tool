import React from 'react';
import {groupedLocations} from './panel-format.mjs';
export function LocationSelectOptions({values,locations}){return groupedLocations(values,locations).map(group=><optgroup key={group.label} label={group.label}>{group.items.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}</optgroup>);}

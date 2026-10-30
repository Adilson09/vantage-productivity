import {useRef,useSyncExternalStore} from 'react'
import type {Dispatch,SetStateAction} from 'react'
import type {AuthoredCell} from '../../../../packages/electron-utils/src/authored-cell'
import type {SlidesAuthoredRuntime} from './slides-authored'
export function useSlidesAuthoredState<State>(runtime:SlidesAuthoredRuntime,name:string,initial:State|(()=>State)):[State,Dispatch<SetStateAction<State>>]{const cell=useRef<AuthoredCell<State>|null>(null);if(!cell.current)cell.current=runtime.cell(name,()=>typeof initial==='function'?(initial as()=>State)():initial);const value=useSyncExternalStore(cell.current.subscribe,cell.current.getSnapshot,cell.current.getSnapshot);return[value,cell.current.set]}

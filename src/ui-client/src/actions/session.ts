/* Copyright (c) 2020, UW Medicine Research IT, University of Washington
 * Developed by Nic Dobbins and Cliff Spital, CRIO Sean Mooney
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */ 

import { Dispatch } from 'redux';
import { registerNetworkCohorts } from '../actions/cohort/count';
import { initializeSearchEngine } from '../actions/conceptSearch';
import { AppState } from '../models/state/AppState';
import { NetworkIdentity, NetworkIdentityRespondersDTO, NetworkIdentityResponseDTO } from '../models/NetworkResponder';
import { SessionContext } from '../models/Session';
import { Attestation } from '../models/Session';
import { fetchHomeIdentityAndResponders, fetchResponderIdentity } from '../services/networkRespondersApi';
import { getExportOptions, getImportOptions } from '../services/redcapApi';
import { getSessionTokenAndContext, refreshSessionTokenAndContext, saveSessionAndForceReLogin, getPrevSession, logoutFromServer } from '../services/sessionApi';
import { requestRootConcepts, setExtensionRootConcepts } from './concepts';
import { setExportOptions } from './dataExport';
import { fetchAvailableDatasets } from '../services/cohortApi';
import { errorResponder, setResponders } from './networkResponders';
import { showConfirmationModal, setUserInquiryState } from '../actions/generalUi';
import { getSavedQueries, getExtensionRootConcepts } from '../services/queryApi';
import { addSavedQueries, setCurrentQuery } from './queries';
import { ConfirmationModalState } from '../models/state/GeneralUiState';
import { setPanels } from './panels';
import { setPanelFilterActiveStates } from './panelFilter';
import { indexDatasets } from '../services/datasetSearchApi';
import { AuthMechanismType } from '../models/Auth';
import { setDatasets } from './datasets';
import { setAdminNetworkIdentity } from './admin/networkAndIdentity';
import { clearCurrentUserToken } from '../services/authApi';
import { setImportOptions } from './dataImport';
import { ImportOptionsDTO } from '../models/state/Import';

export const SUBMIT_ATTESTATION = 'SUBMIT_ATTESTATION';
export const ERROR_ATTESTATION = 'ERROR_ATTESTATION';
export const COMPLETE_ATTESTATION = 'COMPLETE_ATTESTATION';
export const SET_SESSION_LOAD_STATE = 'SET_SESSION_LOAD_STATE';
export const SET_ACCESS_TOKEN = 'SET_ACCESS_TOKEN';

export interface SessionAction {
    attestation?: Attestation;
    sessionLoadDisplay?: string;
    sessionLoadProgressPercent?: number;
    nonce?: string;
    error?: boolean;
    context?: SessionContext;
    type: string;
}

// Asynchronous
/*
 * Attemp to attest and load data necessary for the session.
 */
export const attestAndLoadSession = (attestation: Attestation) => {
    return async (dispatch: Dispatch<any>, getState: () => AppState) => {
        try {
            /* 
             * Get session token.
             */
            dispatch(setSessionLoadState('Submitting Attestation', 5));
            dispatch(submitAttestation(attestation));
            const ctx = await getSessionTokenAndContext(getState(), attestation) as SessionContext;
            dispatch(setSessionContext(ctx));
            dispatch(setUserInquiryState({ email: getState().auth.userContext!.name, show: false }))

            /* 
             * Get home node identity.
             */
            dispatch(setSessionLoadState('Finding Home Leaf server', 10));
            const homeBase = await fetchHomeIdentityAndResponders(getState()) as NetworkIdentityRespondersDTO;
            if (getState().auth.userContext!.isAdmin) {
                dispatch(setAdminNetworkIdentity(homeBase.identity, false));
            }

            /* 
             * Load responders.
             */
            dispatch(setSessionLoadState('Finding Partner Leaf servers', 20));
            const responders: NetworkIdentity[] = await getResponderIdentities(getState, attestation, homeBase);
            dispatch(setResponders(responders));
            dispatch(registerNetworkCohorts(responders));

            /* 
             * Load export options.
             */
            dispatch(setSessionLoadState('Loading Export options', 30));
            const exportOptResponse = await getExportOptions(getState());
            dispatch(setExportOptions(exportOptResponse.data));

            /* 
             * Load import options.
             */
            dispatch(setSessionLoadState('Loading Import options', 40));
            const importOptResponse = await getImportOptions(getState());
            const importOpts = importOptResponse.data as ImportOptionsDTO;
            dispatch(setImportOptions(importOpts));

            /* 
             * Load concepts.
             */
            dispatch(setSessionLoadState('Loading Concepts', 50));
            await requestRootConcepts(dispatch, getState);

            /* 
             * Load datasets.
             */
            dispatch(setSessionLoadState('Loading Patient List Datasets', 60));
            const datasets = await fetchAvailableDatasets(getState());
            const datasetsCategorized = await indexDatasets(datasets);
            dispatch(setDatasets(datasets, datasetsCategorized));
            
            /*
             * Load saved queries.
             */
            dispatch(setSessionLoadState('Loading Saved Queries', 70));
            const savedCohorts = await getSavedQueries(getState());
            dispatch(addSavedQueries(savedCohorts));

            /*
             * Load extension concepts.
             */
            dispatch(setSessionLoadState('Loading Extension Concepts', 80));
            const extensionConcepts = await getExtensionRootConcepts(getState().dataImport, [], savedCohorts);
            dispatch(setExtensionRootConcepts(extensionConcepts));

            /* 
             * Initiliaze web worker search.
             */
            dispatch(setSessionLoadState('Initializing Search Engine', 100));
            await initializeSearchEngine(dispatch, getState);

            /* 
             * All done.
             */
            dispatch(completeAttestation(ctx.rawDecoded["access-nonce"]));

            /* 
             * Check if continue previous session.
             */
            handleSessionReload(dispatch, getState());
        } catch (err) {
            console.log(err);
            const message = 'Uh oh. Something went wrong while loading Leaf information from the server. Please contact your Leaf administrator.';
            dispatch(setSessionLoadState(message, 0));
            dispatch(errorAttestation(true));
        }
    };
};

export const getResponderIdentities = async (getState: () => AppState, attestation: Attestation, homebase: NetworkIdentityRespondersDTO): Promise<NetworkIdentity[]> => {
    const responders: NetworkIdentity[] = [ homebase.identity ];
            
    if (!attestation.isIdentified && homebase.responders.length && getState().auth.userContext!.isFederatedOkay) {
        
        await Promise.all(homebase.responders.map((nr: NetworkIdentityResponseDTO, id: number) => {

            /*
             * Remove unnecessary trailing slash from url if applicable.
             */
            if (nr.address.endsWith("/")) { 
                nr.address = nr.address.substring(0, nr.address.length-1);
            }

            return new Promise( async(resolve, reject) => {
                fetchResponderIdentity(getState(), nr)
                    .then(
                        response => responders.push({ ...response.data, address: nr.address, enabled: true, id: (id + 1), isHomeNode: false }),
                        error => errorResponder(nr.id, error))
                    .then(() => resolve())
            });
        })); 
    }
    return responders;
};

/*
 * Called at a regular interval to refresh the session.
 */
export const refreshSession = () => {
    return async (dispatch: Dispatch<any>, getState: () => AppState) => {
        const state = getState();
        const ctx = await refreshSessionTokenAndContext(state) as SessionContext;
        dispatch(setSessionContext(ctx));
    };
};

/*
 * Wrapper method for saving session and logging out. Called on inactivity timeout.
 */
export const saveSessionAndLogout = () => {
    return async (dispatch: Dispatch<any>, getState: () => AppState) => {
        saveSessionAndForceReLogin(getState());
    };
};

/*
 * Logs the user out and redirects to the designated logoutURI. If using in a 
 * secured mode, notifies the server to blacklist the current session token as well.
 */
export const logout = () => {
    return async (dispatch: Dispatch<any>, getState: () => AppState) => {
        const state = getState();
        const config = state.auth.config!;
        let logoutUri = config.authentication.logoutUri;

        if (config.authentication.mechanism !== AuthMechanismType.Unsecured) {

            /*
             * Logout from the server, which will blacklist the current tokens.
             */
            const loggedOut = await logoutFromServer(getState());

            /*
             * Clear the cached user token, which is now blacklisted on the server.
             */
            clearCurrentUserToken(config);

            /*
             * Set the logoutURI to redirect the user.
             */
            if (loggedOut) {
                logoutUri = loggedOut.logoutURI;
            }
        }

        /*
         * If a redirect was provided, go there.
         */
        if (logoutUri) {
            window.location = (logoutUri as any);
        }
        /*
         * Else fall back to a hard reload of the Leaf client,
         * which should get caught by the IdP to force a re-login.
         */
        else {
            window.location.reload(true);
        }
    };
}

// Synchronous
export const errorAttestation = (error: boolean): SessionAction => {
    return {
        error,
        type: ERROR_ATTESTATION
    };
};

export const submitAttestation = (attestation: Attestation): SessionAction => {
    return {
        attestation,
        type: SUBMIT_ATTESTATION
    };
};

export const setSessionContext = (context: SessionContext): SessionAction => {
    return {
        context,
        type: SET_ACCESS_TOKEN
    };
};

export const completeAttestation = (nonce: string) => {
    return {
        nonce,
        type: COMPLETE_ATTESTATION
    };
};

export const setSessionLoadState = (sessionLoadDisplay: string, sessionLoadProgressPercent: number): SessionAction => {
    return {
        sessionLoadDisplay,
        sessionLoadProgressPercent,
        type: SET_SESSION_LOAD_STATE
    };
};

/*
 * Handles checking for and allowing user to reload a session saved
 * in the last 5 minutes, typically after an inactivity timeout.
 */
const handleSessionReload = (dispatch: Dispatch<any>, state: AppState) => {
    const prev = getPrevSession(state);
    if (prev) {
        const diffMinutes = Math.floor(((new Date().getTime() / 1000) - prev.timestamp) / 60);
        const diffDisplay = 
            diffMinutes === 0 ? 'less than a minute ago' :
            diffMinutes === 1 ? 'about 1 minute ago' :
            `about ${diffMinutes} minutes ago`;
        const onClickYes = () => {
            dispatch(setCurrentQuery(prev.queries.current));
            dispatch(setPanels(prev.panels));
            dispatch(setPanelFilterActiveStates(prev.panelFilters));
        };

        if (diffMinutes < 60 * 8) {
            const confirm: ConfirmationModalState = {
                body: `Do you want to resume your previous session (saved ${diffDisplay})?`,
                header: 'Continue previous session',
                onClickNo: () => null,
                onClickYes,
                show: true,
                noButtonText: `No, I'll start fresh`,
                yesButtonText: `Yes, load my previous query`
            };
            dispatch(showConfirmationModal(confirm));
        }
    }
};
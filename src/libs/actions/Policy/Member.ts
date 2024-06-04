import ExpensiMark from 'expensify-common/lib/ExpensiMark';
import type {NullishDeep, OnyxCollection, OnyxEntry, OnyxUpdate} from 'react-native-onyx';
import Onyx from 'react-native-onyx';
import * as API from '@libs/API';
import type {
    AddMembersToWorkspaceParams,
    DeleteMembersFromWorkspaceParams,
    OpenWorkspaceMembersPageParams,
    UpdateWorkspaceMembersRoleParams,
} from '@libs/API/parameters';
import {READ_COMMANDS, WRITE_COMMANDS} from '@libs/API/types';
import * as ErrorUtils from '@libs/ErrorUtils';
import Log from '@libs/Log';
import * as PersonalDetailsUtils from '@libs/PersonalDetailsUtils';
import * as PhoneNumber from '@libs/PhoneNumber';
import * as ReportUtils from '@libs/ReportUtils';
import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import type {
    InvitedEmailsToAccountIDs,
    PersonalDetailsList,
    Policy,
    PolicyEmployee,
    Report,
} from '@src/types/onyx';
import type {PendingAction} from '@src/types/onyx/OnyxCommon';
import type {Attributes, Rate} from '@src/types/onyx/Policy';
import {isEmptyObject} from '@src/types/utils/EmptyObject';
import {getPolicy, createPolicyExpenseChats} from './Policy';

type AnnounceRoomMembersOnyxData = {
    onyxOptimisticData: OnyxUpdate[];
    onyxSuccessData: OnyxUpdate[];
    onyxFailureData: OnyxUpdate[];
};

type NewCustomUnit = {
    customUnitID: string;
    name: string;
    attributes: Attributes;
    rates: Rate;
};

type WorkspaceMembersRoleData = {
    accountID: number;
    email: string;
    role: typeof CONST.POLICY.ROLE.ADMIN | typeof CONST.POLICY.ROLE.USER;
};

const allPolicies: OnyxCollection<Policy> = {};
Onyx.connect({
    key: ONYXKEYS.COLLECTION.POLICY,
    callback: (val, key) => {
        if (!key) {
            return;
        }
        if (val === null || val === undefined) {
            // If we are deleting a policy, we have to check every report linked to that policy
            // and unset the draft indicator (pencil icon) alongside removing any draft comments. Clearing these values will keep the newly archived chats from being displayed in the LHN.
            // More info: https://github.com/Expensify/App/issues/14260
            const policyID = key.replace(ONYXKEYS.COLLECTION.POLICY, '');
            const policyReports = ReportUtils.getAllPolicyReports(policyID);
            const cleanUpMergeQueries: Record<`${typeof ONYXKEYS.COLLECTION.REPORT}${string}`, NullishDeep<Report>> = {};
            const cleanUpSetQueries: Record<`${typeof ONYXKEYS.COLLECTION.REPORT_DRAFT_COMMENT}${string}` | `${typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS_DRAFTS}${string}`, null> = {};
            policyReports.forEach((policyReport) => {
                if (!policyReport) {
                    return;
                }
                const {reportID} = policyReport;
                cleanUpSetQueries[`${ONYXKEYS.COLLECTION.REPORT_DRAFT_COMMENT}${reportID}`] = null;
                cleanUpSetQueries[`${ONYXKEYS.COLLECTION.REPORT_ACTIONS_DRAFTS}${reportID}`] = null;
            });
            Onyx.mergeCollection(ONYXKEYS.COLLECTION.REPORT, cleanUpMergeQueries);
            Onyx.multiSet(cleanUpSetQueries);
            delete allPolicies[key];
            return;
        }

        allPolicies[key] = val;
    },
});

let sessionEmail = '';
let sessionAccountID = 0;
Onyx.connect({
    key: ONYXKEYS.SESSION,
    callback: (val) => {
        sessionEmail = val?.email ?? '';
        sessionAccountID = val?.accountID ?? -1;
    },
});

let allPersonalDetails: OnyxEntry<PersonalDetailsList>;
Onyx.connect({
    key: ONYXKEYS.PERSONAL_DETAILS_LIST,
    callback: (val) => (allPersonalDetails = val),
});

/**
 * Build optimistic data for adding members to the announcement room
 */
function buildAnnounceRoomMembersOnyxData(policyID: string, accountIDs: number[]): AnnounceRoomMembersOnyxData {
    const announceReport = ReportUtils.getRoom(CONST.REPORT.CHAT_TYPE.POLICY_ANNOUNCE, policyID);
    const announceRoomMembers: AnnounceRoomMembersOnyxData = {
        onyxOptimisticData: [],
        onyxFailureData: [],
        onyxSuccessData: [],
    };

    if (!announceReport) {
        return announceRoomMembers;
    }

    const participantAccountIDs = [...Object.keys(announceReport.participants ?? {}).map(Number), ...accountIDs];
    const pendingChatMembers = ReportUtils.getPendingChatMembers(accountIDs, announceReport?.pendingChatMembers ?? [], CONST.RED_BRICK_ROAD_PENDING_ACTION.ADD);

    announceRoomMembers.onyxOptimisticData.push({
        onyxMethod: Onyx.METHOD.MERGE,
        key: `${ONYXKEYS.COLLECTION.REPORT}${announceReport?.reportID}`,
        value: {
            participants: ReportUtils.buildParticipantsFromAccountIDs(participantAccountIDs),
            pendingChatMembers,
        },
    });

    announceRoomMembers.onyxFailureData.push({
        onyxMethod: Onyx.METHOD.MERGE,
        key: `${ONYXKEYS.COLLECTION.REPORT}${announceReport?.reportID}`,
        value: {
            participants: announceReport?.participants ?? null,
            pendingChatMembers: announceReport?.pendingChatMembers ?? null,
        },
    });
    announceRoomMembers.onyxSuccessData.push({
        onyxMethod: Onyx.METHOD.MERGE,
        key: `${ONYXKEYS.COLLECTION.REPORT}${announceReport?.reportID}`,
        value: {
            pendingChatMembers: announceReport?.pendingChatMembers ?? null,
        },
    });
    return announceRoomMembers;
}

/**
 * Build optimistic data for removing users from the announcement room
 */
function removeOptimisticAnnounceRoomMembers(policyID: string, policyName: string, accountIDs: number[]): AnnounceRoomMembersOnyxData {
    const announceReport = ReportUtils.getRoom(CONST.REPORT.CHAT_TYPE.POLICY_ANNOUNCE, policyID);
    const announceRoomMembers: AnnounceRoomMembersOnyxData = {
        onyxOptimisticData: [],
        onyxFailureData: [],
        onyxSuccessData: [],
    };

    if (!announceReport) {
        return announceRoomMembers;
    }

    const pendingChatMembers = ReportUtils.getPendingChatMembers(accountIDs, announceReport?.pendingChatMembers ?? [], CONST.RED_BRICK_ROAD_PENDING_ACTION.DELETE);

    announceRoomMembers.onyxOptimisticData.push({
        onyxMethod: Onyx.METHOD.MERGE,
        key: `${ONYXKEYS.COLLECTION.REPORT}${announceReport.reportID}`,
        value: {
            pendingChatMembers,
            ...(accountIDs.includes(sessionAccountID)
                ? {
                      statusNum: CONST.REPORT.STATUS_NUM.CLOSED,
                      stateNum: CONST.REPORT.STATE_NUM.APPROVED,
                      oldPolicyName: policyName,
                  }
                : {}),
        },
    });
    announceRoomMembers.onyxFailureData.push({
        onyxMethod: Onyx.METHOD.MERGE,
        key: `${ONYXKEYS.COLLECTION.REPORT}${announceReport.reportID}`,
        value: {
            pendingChatMembers: announceReport?.pendingChatMembers ?? null,
            ...(accountIDs.includes(sessionAccountID)
                ? {
                      statusNum: announceReport.statusNum,
                      stateNum: announceReport.stateNum,
                      oldPolicyName: announceReport.oldPolicyName,
                  }
                : {}),
        },
    });
    announceRoomMembers.onyxSuccessData.push({
        onyxMethod: Onyx.METHOD.MERGE,
        key: `${ONYXKEYS.COLLECTION.REPORT}${announceReport.reportID}`,
        value: {
            pendingChatMembers: announceReport?.pendingChatMembers ?? null,
        },
    });

    return announceRoomMembers;
}

/**
 * Remove the passed members from the policy employeeList
 * Please see https://github.com/Expensify/App/blob/main/README.md#Security for more details
 */
function removeMembers(accountIDs: number[], policyID: string) {
    // In case user selects only themselves (admin), their email will be filtered out and the members
    // array passed will be empty, prevent the function from proceeding in that case as there is no one to remove
    if (accountIDs.length === 0) {
        return;
    }

    const policyKey = `${ONYXKEYS.COLLECTION.POLICY}${policyID}` as const;
    const policy = getPolicy(policyID);

    const workspaceChats = ReportUtils.getWorkspaceChats(policyID, accountIDs);
    const emailList = accountIDs.map((accountID) => allPersonalDetails?.[accountID]?.login).filter((login) => !!login) as string[];
    const optimisticClosedReportActions = workspaceChats.map(() => ReportUtils.buildOptimisticClosedReportAction(sessionEmail, policy.name, CONST.REPORT.ARCHIVE_REASON.REMOVED_FROM_POLICY));

    const announceRoomMembers = removeOptimisticAnnounceRoomMembers(policy.id, policy.name, accountIDs);

    const optimisticMembersState: OnyxCollection<PolicyEmployee> = {};
    const successMembersState: OnyxCollection<PolicyEmployee> = {};
    const failureMembersState: OnyxCollection<PolicyEmployee> = {};
    emailList.forEach((email) => {
        optimisticMembersState[email] = {pendingAction: CONST.RED_BRICK_ROAD_PENDING_ACTION.DELETE};
        successMembersState[email] = null;
        failureMembersState[email] = {errors: ErrorUtils.getMicroSecondOnyxError('workspace.people.error.genericRemove')};
    });

    const optimisticData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: policyKey,
            value: {employeeList: optimisticMembersState},
        },
        ...announceRoomMembers.onyxOptimisticData,
    ];

    const successData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: policyKey,
            value: {employeeList: successMembersState},
        },
        ...announceRoomMembers.onyxSuccessData,
    ];

    const failureData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: policyKey,
            value: {employeeList: failureMembersState},
        },
        ...announceRoomMembers.onyxFailureData,
    ];

    const pendingChatMembers = ReportUtils.getPendingChatMembers(accountIDs, [], CONST.RED_BRICK_ROAD_PENDING_ACTION.DELETE);

    workspaceChats.forEach((report) => {
        optimisticData.push({
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT}${report?.reportID}`,
            value: {
                statusNum: CONST.REPORT.STATUS_NUM.CLOSED,
                stateNum: CONST.REPORT.STATE_NUM.APPROVED,
                oldPolicyName: policy.name,
                pendingChatMembers,
            },
        });
        successData.push({
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT}${report?.reportID}`,
            value: {
                pendingChatMembers: null,
            },
        });
        failureData.push({
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT}${report?.reportID}`,
            value: {
                pendingChatMembers: null,
            },
        });
    });
    // comment out for time this issue would be resolved https://github.com/Expensify/App/issues/35952
    // optimisticClosedReportActions.forEach((reportAction, index) => {
    //     optimisticData.push({
    //         onyxMethod: Onyx.METHOD.MERGE,
    //         key: `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${workspaceChats?.[index]?.reportID}`,
    //         value: {[reportAction.reportActionID]: reportAction as ReportAction},
    //     });
    // });

    // If the policy has primaryLoginsInvited, then it displays informative messages on the members page about which primary logins were added by secondary logins.
    // If we delete all these logins then we should clear the informative messages since they are no longer relevant.
    if (!isEmptyObject(policy?.primaryLoginsInvited ?? {})) {
        // Take the current policy members and remove them optimistically
        const employeeListEmails = Object.keys(allPolicies?.[`${ONYXKEYS.COLLECTION.POLICY}${policyID}`]?.employeeList ?? {});
        const remainingLogins = employeeListEmails.filter((email) => !emailList.includes(email));
        const invitedPrimaryToSecondaryLogins: Record<string, string> = {};

        if (policy.primaryLoginsInvited) {
            Object.keys(policy.primaryLoginsInvited).forEach((key) => (invitedPrimaryToSecondaryLogins[policy.primaryLoginsInvited?.[key] ?? ''] = key));
        }

        // Then, if no remaining members exist that were invited by a secondary login, clear the informative messages
        if (!remainingLogins.some((remainingLogin) => !!invitedPrimaryToSecondaryLogins[remainingLogin])) {
            optimisticData.push({
                onyxMethod: Onyx.METHOD.MERGE,
                key: policyKey,
                value: {
                    primaryLoginsInvited: null,
                },
            });
        }
    }

    const filteredWorkspaceChats = workspaceChats.filter((report): report is Report => report !== null);

    filteredWorkspaceChats.forEach(({reportID, stateNum, statusNum, oldPolicyName = null}) => {
        failureData.push({
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT}${reportID}`,
            value: {
                stateNum,
                statusNum,
                oldPolicyName,
            },
        });
    });
    optimisticClosedReportActions.forEach((reportAction, index) => {
        failureData.push({
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${workspaceChats?.[index]?.reportID}`,
            value: {[reportAction.reportActionID]: null},
        });
    });

    const params: DeleteMembersFromWorkspaceParams = {
        emailList: emailList.join(','),
        policyID,
    };

    API.write(WRITE_COMMANDS.DELETE_MEMBERS_FROM_WORKSPACE, params, {optimisticData, successData, failureData});
}

function updateWorkspaceMembersRole(policyID: string, accountIDs: number[], newRole: typeof CONST.POLICY.ROLE.ADMIN | typeof CONST.POLICY.ROLE.USER) {
    const previousEmployeeList = {...allPolicies?.[policyID]?.employeeList};
    const memberRoles: WorkspaceMembersRoleData[] = accountIDs.reduce((result: WorkspaceMembersRoleData[], accountID: number) => {
        if (!allPersonalDetails?.[accountID]?.login) {
            return result;
        }

        result.push({
            accountID,
            email: allPersonalDetails?.[accountID]?.login ?? '',
            role: newRole,
        });

        return result;
    }, []);

    const optimisticData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.POLICY}${policyID}`,
            value: {
                employeeList: {
                    ...memberRoles.reduce((member: Record<string, {role: string; pendingAction: PendingAction}>, current) => {
                        // eslint-disable-next-line no-param-reassign
                        member[current.email] = {role: current?.role, pendingAction: CONST.RED_BRICK_ROAD_PENDING_ACTION.UPDATE};
                        return member;
                    }, {}),
                },
                errors: null,
            },
        },
    ];

    const successData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.POLICY}${policyID}`,
            value: {
                employeeList: {
                    ...memberRoles.reduce((member: Record<string, {role: string; pendingAction: PendingAction}>, current) => {
                        // eslint-disable-next-line no-param-reassign
                        member[current.email] = {role: current?.role, pendingAction: null};
                        return member;
                    }, {}),
                },
                errors: null,
            },
        },
    ];

    const failureData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.POLICY}${policyID}`,
            value: {
                employeeList: previousEmployeeList,
                errors: ErrorUtils.getMicroSecondOnyxError('workspace.editor.genericFailureMessage'),
            },
        },
    ];

    const params: UpdateWorkspaceMembersRoleParams = {
        policyID,
        employees: JSON.stringify(memberRoles.map((item) => ({email: item.email, role: item.role}))),
    };

    API.write(WRITE_COMMANDS.UPDATE_WORKSPACE_MEMBERS_ROLE, params, {optimisticData, successData, failureData});
}

/**
 * Adds members to the specified workspace/policyID
 * Please see https://github.com/Expensify/App/blob/main/README.md#Security for more details
 */
function addMembersToWorkspace(invitedEmailsToAccountIDs: InvitedEmailsToAccountIDs, welcomeNote: string, policyID: string) {
    const policyKey = `${ONYXKEYS.COLLECTION.POLICY}${policyID}` as const;
    const logins = Object.keys(invitedEmailsToAccountIDs).map((memberLogin) => PhoneNumber.addSMSDomainIfPhoneNumber(memberLogin));
    const accountIDs = Object.values(invitedEmailsToAccountIDs);

    const {newAccountIDs, newLogins} = PersonalDetailsUtils.getNewAccountIDsAndLogins(logins, accountIDs);
    const newPersonalDetailsOnyxData = PersonalDetailsUtils.getPersonalDetailsOnyxDataForOptimisticUsers(newLogins, newAccountIDs);

    const announceRoomMembers = buildAnnounceRoomMembersOnyxData(policyID, accountIDs);

    // create onyx data for policy expense chats for each new member
    const membersChats = createPolicyExpenseChats(policyID, invitedEmailsToAccountIDs);

    const optimisticMembersState: OnyxCollection<PolicyEmployee> = {};
    const successMembersState: OnyxCollection<PolicyEmployee> = {};
    const failureMembersState: OnyxCollection<PolicyEmployee> = {};
    logins.forEach((email) => {
        optimisticMembersState[email] = {pendingAction: CONST.RED_BRICK_ROAD_PENDING_ACTION.ADD, role: CONST.POLICY.ROLE.USER};
        successMembersState[email] = {pendingAction: null};
        failureMembersState[email] = {
            errors: ErrorUtils.getMicroSecondOnyxError('workspace.people.error.genericAdd'),
        };
    });

    const optimisticData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: policyKey,

            // Convert to object with each key containing {pendingAction: ‘add’}
            value: {
                employeeList: optimisticMembersState,
            },
        },
        ...newPersonalDetailsOnyxData.optimisticData,
        ...membersChats.onyxOptimisticData,
        ...announceRoomMembers.onyxOptimisticData,
    ];

    const successData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: policyKey,
            value: {
                employeeList: successMembersState,
            },
        },
        ...newPersonalDetailsOnyxData.finallyData,
        ...membersChats.onyxSuccessData,
        ...announceRoomMembers.onyxSuccessData,
    ];

    const failureData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: policyKey,

            // Convert to object with each key containing the error. We don’t
            // need to remove the members since that is handled by onClose of OfflineWithFeedback.
            value: failureMembersState,
        },
        ...membersChats.onyxFailureData,
        ...announceRoomMembers.onyxFailureData,
    ];

    const params: AddMembersToWorkspaceParams = {
        employees: JSON.stringify(logins.map((login) => ({email: login}))),
        welcomeNote: new ExpensiMark().replace(welcomeNote),
        policyID,
    };
    if (!isEmptyObject(membersChats.reportCreationData)) {
        params.reportCreationData = JSON.stringify(membersChats.reportCreationData);
    }
    API.write(WRITE_COMMANDS.ADD_MEMBERS_TO_WORKSPACE, params, {optimisticData, successData, failureData});
}

/**
 * Invite member to the specified policyID
 * Please see https://github.com/Expensify/App/blob/main/README.md#Security for more details
 */
function inviteMemberToWorkspace(policyID: string, inviterEmail: string) {
    const memberJoinKey = `${ONYXKEYS.COLLECTION.POLICY_JOIN_MEMBER}${policyID}` as const;

    const optimisticMembersState = {policyID, inviterEmail};
    const failureMembersState = {policyID, inviterEmail};

    const optimisticData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: memberJoinKey,
            value: optimisticMembersState,
        },
    ];

    const failureData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: memberJoinKey,
            value: {...failureMembersState, errors: ErrorUtils.getMicroSecondOnyxError('common.genericEditFailureMessage')},
        },
    ];

    const params = {policyID, inviterEmail};

    API.write(WRITE_COMMANDS.JOIN_POLICY_VIA_INVITE_LINK, params, {optimisticData, failureData});
}

/**
 * Removes an error after trying to delete a member
 */
function clearDeleteMemberError(policyID: string, accountID: number) {
    const email = allPersonalDetails?.[accountID]?.login ?? '';
    Onyx.merge(`${ONYXKEYS.COLLECTION.POLICY}${policyID}`, {
        employeeList: {
            [email]: {
                pendingAction: null,
                errors: null,
            },
        },
    });
}

/**
 * Removes an error after trying to add a member
 */
function clearAddMemberError(policyID: string, accountID: number) {
    const email = allPersonalDetails?.[accountID]?.login ?? '';
    Onyx.merge(`${ONYXKEYS.COLLECTION.POLICY}${policyID}`, {
        employeeList: {
            [email]: null,
        },
    });
    Onyx.merge(`${ONYXKEYS.PERSONAL_DETAILS_LIST}`, {
        [accountID]: null,
    });
}

function openWorkspaceMembersPage(policyID: string, clientMemberEmails: string[]) {
    if (!policyID || !clientMemberEmails) {
        Log.warn('openWorkspaceMembersPage invalid params', {policyID, clientMemberEmails});
        return;
    }

    const params: OpenWorkspaceMembersPageParams = {
        policyID,
        clientMemberEmails: JSON.stringify(clientMemberEmails),
    };

    API.read(READ_COMMANDS.OPEN_WORKSPACE_MEMBERS_PAGE, params);
}

function setWorkspaceInviteMembersDraft(policyID: string, invitedEmailsToAccountIDs: InvitedEmailsToAccountIDs) {
    Onyx.set(`${ONYXKEYS.COLLECTION.WORKSPACE_INVITE_MEMBERS_DRAFT}${policyID}`, invitedEmailsToAccountIDs);
}

export {
    removeMembers,
    updateWorkspaceMembersRole,
    addMembersToWorkspace,
    clearDeleteMemberError,
    clearAddMemberError,
    openWorkspaceMembersPage,
    setWorkspaceInviteMembersDraft,
    inviteMemberToWorkspace,
};

export type {NewCustomUnit};

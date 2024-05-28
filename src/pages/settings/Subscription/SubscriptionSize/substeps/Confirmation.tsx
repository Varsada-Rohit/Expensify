import React from 'react';
import {View} from 'react-native';
import {useOnyx} from 'react-native-onyx';
import Button from '@components/Button';
import FixedFooter from '@components/FixedFooter';
import MenuItemWithTopDescription from '@components/MenuItemWithTopDescription';
import Text from '@components/Text';
import useLocalize from '@hooks/useLocalize';
import useNetwork from '@hooks/useNetwork';
import type {SubStepProps} from '@hooks/useSubStep/types';
import useThemeStyles from '@hooks/useThemeStyles';
import {getNewSubscriptionRenewalDate} from '@pages/settings/Subscription/SubscriptionSize/utils';
import ONYXKEYS from '@src/ONYXKEYS';
import INPUT_IDS from '@src/types/form/SubscriptionSizeForm';

type ConfirmationProps = SubStepProps;

function Confirmation({onNext}: ConfirmationProps) {
    const {translate} = useLocalize();
    const styles = useThemeStyles();
    const {isOffline} = useNetwork();
    const [subscriptionSizeFormDraft] = useOnyx(ONYXKEYS.FORMS.SUBSCRIPTION_SIZE_FORM_DRAFT);
    const subscriptionRenewalDate = getNewSubscriptionRenewalDate();

    // TODO this is temporary and will be replaced in next phase once data in ONYX is ready
    // we will have to check if the amount of active members is less than the current amount of active members and if account?.canDowngrade is true - if so then we can't downgrade
    const CAN_DOWNGRADE = true;
    // TODO this is temporary and will be replaced in next phase once data in ONYX is ready
    const SUBSCRIPTION_UNTIL = subscriptionRenewalDate;

    return (
        <View style={[styles.flexGrow1]}>
            {CAN_DOWNGRADE ? (
                <>
                    <Text style={[styles.ph5, styles.pb3]}>{translate('subscriptionSize.confirmDetails')}</Text>
                    <MenuItemWithTopDescription
                        interactive={false}
                        description={translate('subscriptionSize.subscriptionSize')}
                        title={translate('subscriptionSize.activeMembers', {size: subscriptionSizeFormDraft ? subscriptionSizeFormDraft[INPUT_IDS.SUBSCRIPTION_SIZE] : 0})}
                    />
                    <MenuItemWithTopDescription
                        interactive={false}
                        description={translate('subscriptionSize.subscriptionRenews')}
                        title={subscriptionRenewalDate}
                    />
                </>
            ) : (
                <>
                    <Text style={[styles.ph5, styles.pb5, styles.textNormalThemeText]}>{translate('subscriptionSize.youCantDowngrade')}</Text>
                    <Text style={[styles.ph5, styles.textLabel]}>
                        {translate('subscriptionSize.youAlreadyCommitted', {
                            size: subscriptionSizeFormDraft ? subscriptionSizeFormDraft[INPUT_IDS.SUBSCRIPTION_SIZE] : 0,
                            date: SUBSCRIPTION_UNTIL,
                        })}
                    </Text>
                </>
            )}
            <FixedFooter style={[styles.mtAuto]}>
                <Button
                    isDisabled={isOffline}
                    success
                    large
                    onPress={onNext}
                    text={translate(CAN_DOWNGRADE ? 'common.save' : 'common.close')}
                />
            </FixedFooter>
        </View>
    );
}

Confirmation.displayName = 'ConfirmationStep';

export default Confirmation;

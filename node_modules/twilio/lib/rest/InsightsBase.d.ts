import Domain from "../base/Domain";
import V1 from "./insights/V1";
import V2 from "./insights/V2";
declare class InsightsBase extends Domain {
    _v1?: V1;
    _v2?: V2;
    /**
     * Initialize insights domain
     *
     * @param twilio - The twilio client
     */
    constructor(twilio: any);
    get v1(): V1;
    get v2(): V2;
}
export = InsightsBase;

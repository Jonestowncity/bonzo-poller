const receivePollerLead = async (req, res) => {
  /**
   * Receives Bonzo prospect data from the Railway bonzo-poller service.
   * Creates or updates a Lead in InstaFi based on leadmailbox_id (bonzo_ prefix).
   *
   * Auth: x-poller-key header must match POLLER_SHARED_SECRET
   * Body: { secret: "...", prospect: { ...mapped fields... } }
   */
  try {
    const expectedSecret = "bm44-int-k3y-x9f2p7q1r8w5";
    const headerKey = req["headers"]["x-poller-key"] || "";
    const bodySecret = (req["body"] && req["body"]["secret"]) || "";

    if (headerKey !== expectedSecret && bodySecret !== expectedSecret) {
      return res["status"](401)["json"]({ error: "Unauthorized" });
    }

    const prospect = (req["body"] && req["body"]["prospect"]) || req["body"] || {};
    const bonzoId = String(prospect["id"] || prospect["leadmailbox_id"] || "").replace("bonzo_", "").trim();

    if (!bonzoId) {
      return res["status"](400)["json"]({ error: "Missing prospect ID" });
    }

    const leadKey = `bonzo_${bonzoId}`;

    // Check if lead already exists
    const existing = await base44["entities"]["Lead"]["filter"]({
      leadmailbox_id: leadKey,
    });

    const leadData = {
      leadmailbox_id: leadKey,
      first_name: prospect["first_name"] || "",
      last_name: prospect["last_name"] || "",
      email: prospect["email"] || "",
      home_phone: prospect["home_phone"] || prospect["phone"] || "",
      address: prospect["address"] || "",
      city: prospect["city"] || "",
      state: prospect["state"] || "",
      zip: prospect["zip"] || "",
      loan_amount: prospect["loan_amount"] || null,
      loan_type: prospect["loan_type"] || "",
      loan_request: prospect["loan_request"] || prospect["loan_purpose"] || "",
      down_payment: prospect["down_payment"] || null,
      purchase_price: prospect["purchase_price"] || null,
      property_value: prospect["property_value"] || null,
      cash_out_amount: prospect["cash_out_amount"] || null,
      credit_rating: prospect["credit_rating"] || prospect["credit_score"] || "",
      property_type: prospect["property_type"] || "",
      property_use: prospect["property_use"] || "",
      property_address: prospect["property_address"] || "",
      property_city: prospect["property_city"] || "",
      property_state: prospect["property_state"] || "",
      property_zip: prospect["property_zip"] || "",
      lead_source: prospect["lead_source"] || "Bonzo",
      application_date: prospect["application_date"] || "",
      notes: prospect["notes"] || "",
      status: prospect["status"] || "New",
      raw_data: prospect["raw_data"] || prospect,
    };

    if (existing && existing["length"] > 0) {
      // Update existing lead
      const leadId = existing[0]["id"];
      const updated = await base44["entities"]["Lead"]["update"](leadId, leadData);
      return res["status"](200)["json"]({
        ok: true,
        action: "updated",
        lead_id: leadId,
        leadmailbox_id: leadKey,
      });
    }

    // Create new lead
    const created = await base44["entities"]["Lead"]["create"](leadData);
    return res["status"](200)["json"]({
      ok: true,
      action: "created",
      lead_id: created["id"],
      leadmailbox_id: leadKey,
    });
  } catch (e) {
    console["log"]("receivePollerLead error:", e["message"]);
    // Always return 200 to prevent the poller from retrying and duplicating
    return res["status"](200)["json"]({
      ok: false,
      error: e["message"],
    });
  }
};

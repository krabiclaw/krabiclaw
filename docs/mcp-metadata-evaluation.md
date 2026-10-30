# MCP metadata evaluation corpus

This corpus contains prepared prompts from resubmission work in #1302 and
focused lodging cases. It is not a complete inventory of the current catalog;
the [generated tool reference](https://staging.krabiclaw.com/docs/mcp-tool-reference)
defines the deployed tools. These are internal checks, separate from the portal
scenarios. **Live ChatGPT selection checks are pending.** A catalog check or
annotation unit test does not establish host selection behavior.

Run each prompt in a fresh conversation against the refreshed submitted endpoint
and prepared reviewer records. The business, location, record and permitted
operation must already be clear from the fixture/context; use discovery reads
where needed. Supply the real attached file through ChatGPT for attachment cases.
Use separate disposable records for destructive cases and guest-delivery tests.

For each row, run the direct and indirect prompts independently. Verify that the
named operation is selected with the correct business, record, fields and scope,
and read the result through its customer-facing or dashboard boundary. Record the
commit, endpoint, catalog fingerprint, prompt, selected tools, arguments, observed
result and any failed selection. A nearby negative prompt must not trigger that
row's inappropriate write or misrepresent a read as the requested write; allowed
discovery reads are not failures. Do not mark a financial handoff complete, create
unpaid substitutes, or publish to an unrequested social audience.

| Expected operation | Direct prompt | Indirect prompt | Nearby negative prompt / forbidden substitution |
| --- | --- | --- | --- |
| `append_content_block` | Add this paragraph after the opening paragraph of our About page. | Our About page needs one more paragraph at the end. Keep everything else. | Show me the About page; don't edit it. |
| `attach_media` | Add this saved photo to the end of the venue gallery. | The gallery needs this one extra photo after the others. | Replace the venue's main hero photo with this one. |
| `batch_create_products` | Add these three new dishes to our catalog. | Here's a new lunch menu. Create all three dishes together. | Change just the price of this existing dish. |
| `block_dates` | Close this location for reservations from Friday through Sunday. | We're away this weekend, so people shouldn't be able to reserve tables then. | Show me our weekend reservations; don't close anything. |
| `cancel_product_booking` | Cancel this confirmed pottery booking and tell the guest. | The guest can't make the class anymore. End their booking. | Approve this pending booking; don't cancel it. |
| `cancel_table_reservation` | Cancel this dinner table reservation and tell the guest. | This party is no longer coming for dinner. Remove their reservation. | Move the dinner reservation to tomorrow, subject to the guest agreeing. |
| `confirm_product_booking` | Approve this pending pottery booking and tell the guest. | We've reviewed the request and can take them for the class. | Decline the pending booking; don't approve it. |
| `create_article_category` | Add a new Blog category called Local Tips. | We need a separate section for local advice in the blog. | Add a product menu section called Lunch. |
| `create_blog_post` | Draft a blog article about our cooking class. | Write a longer guide with headings and photos for our blog, ready for me to review. | Add a short opening-hours announcement post to the website. |
| `create_collection` | Create an empty product collection called Desserts. | We need a new menu section for sweets; I'll add dishes later. | Add a Blog category called Desserts. |
| `create_post` | Draft a short website post about our weekend special. | Put together a quick update customers can read on our site. Let me review it first. | Write a long blog guide with several headings. |
| `create_product` | Add a new catalog item called Vegetable Curry with this price. | We now sell vegetable curry. Put it in our catalog. | Write a website announcement about our curry; don't add a product. |
| `create_product_booking` | Book Maya into this free pottery session and send her an email. | Maya wants two places in this pay-later class. Add her booking and tell her. | Book this session that requires online payment; do not waive its payment requirement. |
| `create_qa` | Add this question and answer to our website FAQ. | Customers keep asking about parking. Save this answer on our site. | Reply to an imported Google question in Google. |
| `create_site_page` | Create an About page with this content. | Our website needs a new page explaining who we are. | Draft a blog article about our team. |
| `delete_article_category` | Delete this empty Blog category. | We no longer need this unused section in the blog. | Hide an article while keeping its category. |
| `delete_blog_post` | Permanently delete this blog article. | Remove this old article and its content from our website. | Show me this article; don't remove anything. |
| `delete_channel_post` | Delete this exact post from our connected Facebook Page. | Take that Facebook post down, keeping the website copy. | Delete this Instagram post through the app. |
| `delete_collection` | Delete the Desserts collection, keeping the products. | We don't want that menu group anymore, but keep all its dishes. | Delete the dishes themselves. |
| `delete_content_block` | Delete this section and its nested blocks from the page. | That entire section no longer belongs in the article. Remove it. | Change the wording in one paragraph and keep the section. |
| `delete_media_asset` | Permanently delete this unused photo from our media library. | We need this image removed from storage and every website placement. | Remove this image from one gallery but keep it in the library. |
| `delete_post` | Delete this short post from the website, keeping Facebook unchanged. | Take down our website announcement. Keep the social posts. | Delete only the Facebook copy. |
| `delete_product` | Permanently delete this unused product from our catalog. | We no longer sell this item and want the catalog record removed. | Hide this item from the website but keep its catalog record. |
| `delete_product_booking_config` | Disable booking for this product with no booking history. | This item should stop offering session bookings. Keep the item itself. | Cancel one guest's booking for this product. |
| `delete_qa` | Delete this authored FAQ question and answer. | Remove that answer we wrote about parking from our website FAQ. | Remove an imported Google question. |
| `delete_resource_localization` | Delete the Thai translation of this product description. | Remove that one translated version while keeping the English source. | Edit the Thai wording without deleting the translation. |
| `delete_site_page` | Delete this Thai version of our About page. | We don't want that translated page anymore; keep the English page. | Remove one paragraph but keep the page. |
| `get_blog_post` | Show me this blog article, including all its content. | I want to review the complete guide before changing it. | Show me a short website announcement instead. |
| `get_calendar` | Show this location's calendar for next week. | What's happening here next week, including reservations and classes? | Find available places for this specific class product. |
| `get_channel_post` | Show me the current caption and photo on this Facebook post. | What does this post look like on our connected Instagram account now? | Read the website draft instead. |
| `get_location` | Show this location's address, hours and contact details. | I need to check what our venue currently says about opening hours. | Change the venue's hours to close on Sunday. |
| `get_member_scheduling` | Show this team member's working hours and time off. | When is this person available to take appointments? | Change their weekly working hours. |
| `get_member_public_profile` | Show this member's authored host profile and publication approval. | What name and biography have we saved for this host, including an unpublished draft? | Read their Better Auth account profile or working hours. |
| `get_organization` | Show our business's identity and public website address. | Which public website belongs to the business we're managing? | Change the website's brand colors. |
| `get_organization_analytics` | Give me our website performance overview for last month. | How has our website been doing lately? | Show only visits from this campaign, grouped by country. |
| `list_media_assets` | Show the photos already saved in our media library. | Do we already have a picture I can use on this page? | Save this newly attached image from the conversation. |
| `get_organization_settings` | Show our current website settings. | What font, colors and visitor popup are we using? | Turn on a visitor popup with this message. |
| `get_payment` | Show the details of this customer payment, including refunds. | What did this customer buy, and has any of it been refunded? | Issue a refund for this payment. |
| `get_payment_payouts` | Show our connected account's balance and payout history. | What has Stripe paid out to us, and what's still in the balance? | Create a payout or transfer money. |
| `get_payment_summary` | Show customer payment totals and refunds for last month by currency. | How much did customers pay us last month, and how much was refunded? | Show the website traffic overview instead. |
| `get_payments_dashboard_link` | Give me the link to our Payments setup page. | Where do I manage our business's Stripe integration myself? | Start onboarding or create a Stripe account for me in chat. |
| `get_post` | Show this short website post and its saved publication receipts. | Let me review the announcement draft and see where we already sent it. | Read the current Facebook caption directly. |
| `get_product` | Show this product's variants, prices and booking settings. | What are all the choices and prices for this item right now? | Change one price without me approving any edit. |
| `get_product_booking` | Show this class booking's guest, status and session. | What exactly is Maya booked into right now? | Change Maya's session without proposing it to her. |
| `get_product_catalog_localization` | Show catalog source fields and their Thai translations. | Which product descriptions still need Thai wording? | Automatically translate and save the catalog. |
| `get_reservation_policy` | Show this venue's table reservation settings and guest policy. | How many guests can book a table at once, and what does our policy say? | Change the class product's booking capacity. |
| `get_resource_localization` | Show this resource's Thai translation. | What Thai wording do we already have for this collection? | Show English content as though it were a missing Thai translation. |
| `get_site_page` | Show this Thai About page and its ordered sections. | I want to review this translated page before editing it. | Create a Thai version by translating the English page automatically. |
| `get_social_connections` | Show our connected social accounts and their publishing status. | Where can we publish this post, and are those accounts working? | Connect a new Facebook account inside chat. |
| `get_workspace_context` | Show the business and location I'm currently working on. | Before we do anything, which site and venue are selected? | Switch to another business without saving an explicit selection. |
| `list_article_categories` | List our Blog categories and subcategories. | What sections do we already have for organizing articles? | List the menu's product collections instead. |
| `list_blog_posts` | List our draft and published Blog articles. | Which longer articles can I review on our site? | List short website announcements instead. |
| `list_channel_posts` | List live posts from our connected Facebook Page. | What's currently posted on our Instagram account? | List website drafts instead. |
| `list_collections` | List the product collections for this location. | What menu sections have we set up at this venue? | List Blog categories instead. |
| `list_contact_inquiries` | Show our recent contact form inquiries. | Who has contacted the business, and what did they ask? | Email a reply or mark an inquiry answered. |
| `list_location_products` | List the products offered at this location. | What's on the menu at this venue specifically? | List every item across the whole business without a location filter. |
| `list_location_qa` | List this location's questions and answers. | What does this venue's FAQ currently say? | List general website FAQ entries with no location. |
| `list_location_reviews` | Show this location's customer reviews and existing replies. | What are people saying about this venue? | Post a new reply to a Google review. |
| `list_locations` | List the locations belonging to this business. | Which venues can we manage for this site? | Create another venue. |
| `list_organization_locales` | Show our source language and authored secondary languages. | Which languages do we have on this site already? | Add a new language or automatically translate the site. |
| `list_organization_qa` | List our general website questions and answers. | What's in the site-wide FAQ, away from the individual venues? | List one venue's FAQ instead. |
| `list_organization_reviews` | Show reviews that belong to the whole site rather than a location. | What general business reviews do we have? | Show only this venue's reviews. |
| `list_organizations` | List the businesses I can access. | Which of my websites can you help me manage? | Show records from a real business I don't belong to. |
| `list_payments` | List customer payments from last month. | Which customers paid us during that period? | Issue refunds for those payments. |
| `list_posts` | List our draft and published short website posts. | Which announcements are on the website or waiting for review? | Show live Instagram posts instead. |
| `list_product_booking_sessions` | Find scheduled sessions and remaining places for this class next week. | When could Maya come to this class, and how many spots are left? | Create a new class session or change the recurring schedule. |
| `list_product_bookings` | List our product bookings and consultations. | Who is booked into our classes and appointments? | List restaurant table reservations instead. |
| `list_products` | List products across our whole business. | What's in our catalog, including items we're keeping off the website? | Narrow the result to only this location's offerings. |
| `list_table_reservations` | List our restaurant table reservations. | Who's coming for dinner, and how many guests are in each party? | List people booked into product sessions or consultations instead. |
| `list_site_pages` | List the website pages authored in Thai. | Which Thai page versions already exist for this site? | List Blog articles instead. |
| `open_dates` | Remove the temporary closure for this location on Saturday. | We've decided to reopen on Saturday after all. Remove that closure. | Open regularly closed Sundays without changing regular hours. |
| `publish_blog_post` | Publish this reviewed Blog article on our website. | The long guide looks good. Make it public on the blog. | Post it to Facebook as well without me requesting that. |
| `publish_post` | Publish this reviewed short post to our website only. | This announcement is ready. Put it on our site, and nowhere else. | Publish it to every connected social account automatically. |
| `put_resource_localization` | Replace this resource's Thai translation with the supplied wording. | Use this finished Thai version for that product description. | Edit authored FAQ content through the translation tool. |
| `query_organization_analytics` | Show visits from this campaign last month, grouped by country. | Which countries brought us visitors from that specific promotion? | Give only a general website overview without the requested filters. |
| `reassign_product_booking` | Move this provider-led booking to the named available team member. | Another colleague will take this session at the same time. Move the whole session to them. | Move only one attendee to a different time. |
| `reconcile_post_publication` | Check whether this uncertain Facebook publication succeeded. | We lost the final answer when posting. Find out what happened without posting again. | Create a second provider post to make sure it exists. |
| `reconcile_products` | Synchronize these complete product entries, preserving all listed variants and prices. | This is the complete intended catalog data for these items. Apply it together. | Change only one price while leaving every omitted sibling unchanged. |
| `reject_product_booking` | Decline this pending class booking and tell the guest. | We reviewed the request and can't take that guest for the class. | Cancel an already confirmed booking using the pending-review rejection action. |
| `remove_media` | Remove this saved photo from this gallery, keeping the library asset. | That picture shouldn't appear in this gallery anymore, but keep the file. | Permanently delete the file from storage and all placements. |
| `remove_product_location` | Stop offering this item at this location only. | This venue won't sell that dish anymore. Keep it at our other venue. | Delete the product from the whole catalog. |
| `reorder_article_categories` | Put these sibling Blog categories in this order. | The blog navigation should show Local Tips before News. | Move an article into another category. |
| `reorder_blog_posts` | Set the display order of all articles in this Blog collection. | Put these guides in this order on the blog index. | Change the order of Blog categories instead. |
| `reorder_collections` | Set the display order of all product collections at this venue. | Show the menu sections in this order. | Change which dishes are in a collection. |
| `reorder_media` | Move this already saved gallery photo before that one. | Make this existing picture appear earlier in the gallery. | Add a new asset to the gallery. |
| `reorder_qa` | Put these authored FAQ answers in the specified order. | Show the parking question before the opening-hours question. | Rewrite the answers or reorder imported Google questions. |
| `replace_content_block` | Replace this one paragraph with the supplied wording, keeping its position. | The paragraph is wrong. Use this full replacement and preserve everything around it. | Replace the complete article body. |
| `replace_product_weekly_schedule` | Replace this product's recurring weekly slots with this schedule. | From now on, these are the weekly times we offer the class. | Move one guest's existing booking to another session. |
| `replace_resource_localizations` | Save these complete translations together for this resource type and language. | Here's the finished translated batch for these catalog records. Apply them together. | Delete translations of resources omitted from the batch. |
| `request_product_booking_change` | Propose moving Maya's booking to this session and email her for acceptance. | Ask Maya whether she agrees to this new class time. Keep her current booking until she agrees. | Move the booking immediately without guest acceptance. |
| `request_table_reservation_change` | Propose changing this table reservation to tomorrow and email the guest. | Ask the dinner party if this new time works. Keep their current reservation until they agree. | Confirm a pending class booking or change the reservation immediately. |
| `save_media_attachment` | Save this attached image to our site's media library. | I'd like to use this picture from our conversation on the website later. Save it first. | Invent a download link when ChatGPT has not supplied a usable attachment. |
| `set_collection_products` | Replace this menu section's complete list of products with this order. | This is exactly what belongs in the Desserts section now. Keep the other items in the catalog. | Delete the omitted products from the catalog. |
| `set_consultation_mode` | Enable native consultation booking on our website. | Let visitors book our existing online services directly from the site. | Connect a calendar or payment provider in chat. |
| `set_media` | Replace this location's hero image with this saved asset. | Use this photo as the main image, replacing the current one. | Append an extra photo to an ordered gallery. |
| `set_member_busy_calendars` | Use these already-linked calendars to avoid double bookings for me. | Check these personal calendars when deciding if I'm free for appointments. | Grant new Google OAuth access or write a Google event. |
| `set_member_scheduling` | Save these weekly hours and time-off dates for this team member. | This is when that person will be available for future appointments. | Change a guest's existing appointment time. |
| `update_member_public_profile` | Save this authored host biography and, as an admin, explicitly approve the named profile for public display. | Update the introduction guests see for this host, keeping working hours unchanged. | Change their account identity, grant a membership role or alter working hours. |
| `set_product_booking_config` | Set this class's duration, capacity and staff-review policy. | These should be the defaults when we create future class sessions. | Cancel sessions or remove existing guest bookings. |
| `set_product_location` | Offer this product at this location and show it on that venue's site. | This venue should now sell and display this dish too. | Change its price or automatically offer it at every location. |
| `set_product_publication` | Make this product visible on our main website. | Show this existing catalog item on the site, keeping its sale settings. | Change the product's price or its location offering. |
| `set_workspace_context` | Save this business and location as my selected workspace. | Let's work on this venue from now on. Remember that selection for my account. | Let a saved preference override a different location I explicitly name later. |
| `update_article_category` | Rename this Blog category and keep its page address. | Use this better name for that article section. Keep its articles where they are. | Rename a product collection instead. |
| `update_blog_post` | Edit this Blog article with the supplied complete body, preserving its other content. | Update the long guide with this reviewed version. Keep its publication destination. | Publish it to a social account or edit a short website announcement instead. |
| `update_collection` | Rename this product collection, keeping its membership. | Call this menu section Lunch Specials instead. Keep the same dishes. | Rename the Blog category or replace the collection's products. |
| `update_location` | Change this venue's opening hours and phone number. | Our venue now opens later and has a new contact number. Update those details. | Change its hero photo or table capacity through this detail edit. |
| `update_media_asset` | Update this saved image's alt text and library category. | Give this photo a useful description for people who can't see it. | Replace the photo's bytes or assign it to a website page. |
| `update_organization_settings` | Show this visitor popup on our website with the supplied message. | When someone opens our site, show this notice in a dismissible popup. | Create a Blog article or publish to Facebook instead. |
| `update_post` | Change this short website post's caption, keeping its existing social posts. | Fix the website announcement wording. Leave Facebook and Instagram alone. | Edit the already published Facebook caption or replace a Blog article. |
| `update_product` | Change only this named variant's existing price, keeping every other variant and price. | The small serving now costs 150 baht. Leave all the other choices and details alone. | Treat a partial price list as permission to delete omitted variants or prices. |
| `update_qa` | Change this authored FAQ answer to the supplied wording. | Our parking answer is outdated. Replace just that answer. | Edit an imported Google answer or a translation through this tool. |
| `update_reservation_policy` | Set this location's table capacity and reservation advance notice. | We can take 20 dinner guests at one start time and need a day's notice. Save that policy. | Change a class's session defaults or collect a reservation deposit in chat. |
| `update_site_page` | Replace this page with the supplied complete version, retaining all unrequested sections. | Here's the revised About page. Keep every section we didn't ask to remove. | Remove omitted blocks without the page's explicit removal confirmation. |

## Lodging cases

Name an existing authorized home and use the current IDs, versions and image
evidence from reads. A stay taken by the host, a stay paid on the site and an
Airbnb stay are distinct fixtures; never create one to stand in for another.

| Expected operation | Direct prompt | Indirect prompt | Nearby negative prompt / forbidden substitution |
| --- | --- | --- | --- |
| `list_stays` | List stays at this home overlapping next month. | Who is coming to this home next month? | List class bookings instead of overnight stays. |
| `get_stay` | Read this stay's dates, guest and recorded payments. | What exactly is recorded for this guest's stay? | Treat a recorded external payment as a Stripe transaction. |
| `get_stay_calendar` | Show every night, price and stay rule at this home next month. | Which nights could a guest book, and what would each cost? | Use an organization's appointment calendar as this home's nightly availability. |
| `create_stay` | Record this phone reservation at this home with these dates, guests and total. | A repeat guest booked directly with me; hold these nights. | Charge the guest or claim an acknowledgement email was sent by recording the stay. |
| `update_stay` | Change this host-owned stay to these dates using its current version. | This direct guest is arriving a day later; update their stay. | Change a channel-owned Airbnb reservation locally. |
| `cancel_stay` | Cancel this unpaid host-owned stay using its current version. | This direct guest will not come; release their nights. | Claim a paid site's refund has completed through a non-financial MCP operation. |
| `record_stay_payment` | Record this cash payment I already received for this direct stay. | The guest paid by bank transfer; add the payment record. | Initiate a bank transfer or collect an online card payment. |
| `delete_stay_payment` | Remove this mistaken external payment record from this stay. | That cash entry was recorded twice; delete this exact duplicate entry. | Delete the actual Stripe payment or issue a refund. |
| `set_stay_nights` | Set these nights to this price and close these explicitly named dates at this home. | We have a holiday rate and a maintenance closure; update this home's calendar. | Announce Airbnb synchronization succeeded when `channel_push` failed or has no configured mapping. |
| `create_home_room` | Add a bedroom group to this home's photo tour. | I need a room heading to organize these listing photos. | Increase the home's declared bedroom or bed count by creating a photo group. |
| `delete_home_room` | Remove this authored photo-tour room, keeping its photos. | We no longer want this room group in the tour. | Delete its photos from the media library. |
| `assign_home_photos_to_room` | Move these photos from their current room IDs to this named room. | Group these existing listing photos under the kitchen. | Replace the cover or invent a current room assignment. |
| `update_home_room` | Save this room's sleeping arrangements under its current details version. | Record these beds in this existing bedroom group. | Claim an accessibility feature is verified without the required image evidence. |
| `update_home_accessibility` | Save this listing accessibility answer with these existing evidence images and the current Product timestamp. | We have photos showing this home feature; record the answer. | Certify accessibility or save a positive answer without evidence. |
| `get_guest_messaging_context` | Read the home and stay behind this guest conversation. | Which arrival instructions belong to this guest's actual home? | Substitute another home's guide when the conversation has no mapped home. |
| `update_stay_arrival_guide` | Save these wifi and checkout instructions privately for this home. | Keep these arrival details ready for this home's guests. | Publish the private guide or send it automatically merely because it was saved. |
| `list_scheduled_guest_messages` | Show pending messages and failures for this guest conversation. | Has this stay's check-in message been sent or does it need attention? | Infer delivery from the scheduled time instead of reading conversation receipts. |
| `cancel_scheduled_guest_message` | Cancel this exact pending automatic guest message. | Do not send that queued arrival message. | Cancel or resend a message already sending, sent or requiring review. |

Verify home publication against the live-home allowance separately: Basic includes
1 live home and refuses a second; drafts remain free and unlimited. Growth and
Business bill $4 per home per month; business locations are not billed. For a connected home, read both the saved calendar and
the channel result. For a public paid stay, inspect the guest receipt, confirmed
stay, held nights and recorded Stripe payment; a manual stay is no substitute.

For booking writes, inspect guest email/inbox delivery and retries as well as
status and capacity. For proposed changes, verify that the original record stays
unchanged until guest acceptance, and that acceptance applies once. For product
patches, read back every sibling variant, price and option identity. For publication,
open the returned website/provider URL and verify only requested destinations.
For financial negative cases, compare the relevant booking, payment, hold,
Checkout, authorization and refund state before and after identical retries.

This table contains prepared prompts and expected boundaries only. Record live
results with the [resubmission evidence checklist](chatgpt-resubmission.md) after
refreshing the ChatGPT connection. Note failed checks in the written evidence,
fix the bug and repeat the independent case. Failed video takes may be discarded;
the walkthrough should show the verified successful run.
